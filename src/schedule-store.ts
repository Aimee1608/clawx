import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { CronExpressionParser } from 'cron-parser'

import { dataDir } from './config.js'

/**
 * Cron-driven scheduled tasks: spawn claude with a given prompt on a
 * recurring schedule and DM the result.
 *
 * Persistent state at $XDG_DATA_HOME/clawx/schedules.json (or
 * ~/.local/share/clawx/...). Atomic writes via tmp + rename, same as
 * session-store / manager-state.
 */

const FILE_VERSION = 1
const HISTORY_CAP = 50

export type ScheduleKind = 'prompt' | 'message'

/** Which agent backend a `prompt` schedule runs against. Only meaningful
 * for `kind: 'prompt'` (a `message` schedule just DMs text). Defaults to
 * 'claude' when unset, so pre-existing schedules stay backward-compatible. */
export type ScheduleAgentKind = 'claude' | 'codex'

export interface Schedule {
  id: string
  name: string
  /**
   * Trigger spec: exactly one of `cron` or `fireAt` must be set.
   *
   * `cron`: standard 5-field cron expression for recurring tasks.
   *   e.g. "0 9 * * 1-5" = mon-fri 9am (in `timezone`).
   * `fireAt`: ISO timestamp for a one-time task. After it fires, the
   *   schedule is auto-disabled so it doesn't refire.
   * `timezone`: optional IANA tz (e.g. "Asia/Shanghai", "UTC"). When
   *   omitted, cron-parser uses the host's local time. Only meaningful
   *   for `cron` triggers — `fireAt` is interpreted as an absolute
   *   instant regardless of zone.
   */
  cron?: string
  fireAt?: string
  timezone?: string
  kind: ScheduleKind
  /** Agent backend for `kind: 'prompt'`. 'claude' (default) spawns a
   * one-shot `claude --print`; 'codex' runs a one-shot `codex exec`.
   * Ignored for `message` kind. Absent on legacy schedules → treated as
   * 'claude'. */
  agentKind?: ScheduleAgentKind
  /**
   * For `prompt`: the user-message text fed to claude --print
   * For `message`: the literal text DM'd to the user
   * For `scan`: ignored (we always run the manager scan flow)
   */
  payload: string
  /** Used only for `prompt` kind. Falls back to config.claudeCwd at run time when omitted. */
  cwd?: string
  /** When set (and `kind: 'prompt'`), the payload is sent into an
   * existing tmux session's claude REPL via send-keys instead of
   * spawning a one-shot `claude --print`. The reply flows back through
   * the normal Stop hook → fanout → Lark thread path, so the operator
   * sees the result in the session's bound thread (no DM). Lets cron
   * jobs reuse a long-lived claude context. */
  tmuxSessionId?: string
  enabled: boolean
  createdAt: string
  /** ISO timestamp of the most recent firing. Used both for skip-while-running
   * deduplication and for cron-parser to compute the next due fire time. */
  lastRunAt?: string
  lastResultPreview?: string
  lastError?: string
}

export interface ScheduleRunRecord {
  id: string
  scheduleId: string
  scheduleName: string
  startedAt: string
  endedAt: string
  ok: boolean
  durationMs: number
  resultPreview: string
  errorMsg?: string
  /** claude session UUID this run wrote to (only for `prompt` kind, where
   * cron-engine pre-allocates a UUID and passes it as `--session-id`). Lets
   * the UI link a schedule run to its full transcript on disk. */
  claudeUuid?: string
}

interface ScheduleStateFile {
  version: number
  schedules: Schedule[]
  history: ScheduleRunRecord[]
}

function defaultState(): ScheduleStateFile {
  return { version: FILE_VERSION, schedules: [], history: [] }
}

export function schedulesPath(): string {
  return path.join(dataDir(), 'schedules.json')
}

export function loadSchedules(): ScheduleStateFile {
  const p = schedulesPath()
  if (!fs.existsSync(p)) return defaultState()
  try {
    const raw = fs.readFileSync(p, 'utf8')
    const parsed = JSON.parse(raw) as Partial<ScheduleStateFile>
    if (parsed.version !== FILE_VERSION) return defaultState()
    return {
      version: FILE_VERSION,
      schedules: Array.isArray(parsed.schedules) ? parsed.schedules : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
    }
  } catch {
    return defaultState()
  }
}

export function saveSchedules(state: ScheduleStateFile): void {
  const p = schedulesPath()
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const tmp = `${p}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, p)
  } catch {
    // Same philosophy as session/manager state: persistence failures are
    // non-fatal. Schedules just won't survive a restart in that pathological
    // case; user can recreate via the UI.
  }
}

// ── Validation ────────────────────────────────────────────────────

/** Returns null when the cron expression parses cleanly, otherwise an
 * error string. We deliberately accept the cron-parser default (5-field
 * expressions); 6-field with seconds is rejected to keep parity with
 * what the UI shows. `tz`, when supplied, is also validated. */
export function validateCron(cron: string, tz?: string): string | null {
  if (!cron || typeof cron !== 'string') return 'cron expression is required'
  if (cron.split(/\s+/).length !== 5) return 'expected 5 cron fields (m h dom mon dow)'
  try {
    CronExpressionParser.parse(cron, tz ? { tz } : undefined)
    return null
  } catch (err: any) {
    return err?.message ?? 'invalid cron expression'
  }
}

/** Returns null when the ISO timestamp parses cleanly AND lies in the future
 * relative to `from`. Used for one-off triggers. */
export function validateFireAt(fireAt: string, from: Date = new Date()): string | null {
  if (!fireAt || typeof fireAt !== 'string') return 'fireAt is required'
  const t = Date.parse(fireAt)
  if (!Number.isFinite(t)) return 'fireAt is not a valid ISO timestamp'
  if (t <= from.getTime()) return 'fireAt must be in the future'
  return null
}

/** Validation common to both create and update: at least one trigger
 * field present and parsing cleanly. */
export interface TriggerInput {
  cron?: string
  fireAt?: string
  timezone?: string
}

export function validateTrigger(t: TriggerInput): string | null {
  const hasCron = !!t.cron && t.cron.trim().length > 0
  const hasFireAt = !!t.fireAt && t.fireAt.trim().length > 0
  if (hasCron && hasFireAt) return 'specify either cron OR fireAt, not both'
  if (!hasCron && !hasFireAt) return 'specify either cron or fireAt'
  if (hasCron) return validateCron(t.cron!, t.timezone)
  return validateFireAt(t.fireAt!)
}

/** Compute the next N fire times for a trigger spec. For `fireAt` triggers
 * this is at most one entry (the future fire time). For `cron` triggers,
 * `count` future runs starting after `from`. Empty array if the trigger
 * is invalid or `fireAt` is in the past. */
export function nextFireTimes(
  trigger: TriggerInput,
  from: Date = new Date(),
  count = 3,
): Date[] {
  if (trigger.fireAt) {
    const d = new Date(trigger.fireAt)
    return Number.isFinite(d.getTime()) && d > from ? [d] : []
  }
  if (!trigger.cron) return []
  try {
    const it = CronExpressionParser.parse(trigger.cron, {
      currentDate: from,
      ...(trigger.timezone ? { tz: trigger.timezone } : {}),
    })
    const out: Date[] = []
    for (let i = 0; i < count; i++) {
      out.push(it.next().toDate())
    }
    return out
  } catch {
    return []
  }
}

/**
 * Decide whether a schedule is due to fire now.
 *
 * For `cron` triggers: anchor cron-parser at the schedule's last run (or
 * createdAt if never run), pull `next()` once, and compare to `now`. If
 * next ≤ now, we're due. This handles missed ticks gracefully — e.g.
 * process was down for 10 minutes; on next tick we still catch up the
 * most recent missed firing without re-firing the older ones.
 *
 * For `fireAt` triggers: due iff hasn't fired yet AND fireAt ≤ now.
 * After firing, the cron engine flips `enabled = false` so the schedule
 * never re-fires.
 */
export function isDue(s: Schedule, now: Date = new Date()): boolean {
  if (!s.enabled) return false

  if (s.fireAt) {
    if (s.lastRunAt) return false // one-off, already fired
    const t = Date.parse(s.fireAt)
    return Number.isFinite(t) && t <= now.getTime()
  }

  if (!s.cron) return false
  const anchor = s.lastRunAt ? new Date(s.lastRunAt) : new Date(s.createdAt)
  try {
    const next = CronExpressionParser.parse(s.cron, {
      currentDate: anchor,
      ...(s.timezone ? { tz: s.timezone } : {}),
    })
      .next()
      .toDate()
    return next <= now
  } catch {
    return false
  }
}

/** True iff this schedule should auto-disable after firing once. Currently
 * only one-off `fireAt` schedules. */
export function isOneOff(s: Schedule): boolean {
  return !!s.fireAt
}

// ── Mutators ──────────────────────────────────────────────────────

export interface CreateScheduleInput {
  name: string
  /** Recurring trigger (mutually exclusive with `fireAt`). */
  cron?: string
  /** One-off trigger ISO timestamp (mutually exclusive with `cron`). */
  fireAt?: string
  /** Optional IANA timezone for `cron`. */
  timezone?: string
  kind: ScheduleKind
  /** Agent backend for `prompt` kind. Defaults to 'claude'. */
  agentKind?: ScheduleAgentKind
  payload: string
  cwd?: string
  tmuxSessionId?: string
  enabled?: boolean
}

export function createSchedule(input: CreateScheduleInput): Schedule {
  const state = loadSchedules()
  const s: Schedule = {
    id: randomUUID(),
    name: input.name.trim(),
    cron: input.cron?.trim() || undefined,
    fireAt: input.fireAt?.trim() || undefined,
    timezone: input.timezone?.trim() || undefined,
    kind: input.kind,
    // Only persist agentKind for prompt schedules, and only when it's the
    // non-default 'codex' — keeps message schedules and the common claude
    // case clean in schedules.json.
    agentKind: input.kind === 'prompt' && input.agentKind === 'codex' ? 'codex' : undefined,
    payload: input.payload,
    cwd: input.cwd?.trim() || undefined,
    tmuxSessionId: input.tmuxSessionId?.trim() || undefined,
    enabled: input.enabled ?? true,
    createdAt: new Date().toISOString(),
  }
  state.schedules.push(s)
  saveSchedules(state)
  return s
}

export type UpdateScheduleInput = Partial<Omit<Schedule, 'id' | 'createdAt'>>

export function updateSchedule(id: string, patch: UpdateScheduleInput): Schedule | null {
  const state = loadSchedules()
  const i = state.schedules.findIndex((s) => s.id === id)
  if (i < 0) return null
  state.schedules[i] = { ...state.schedules[i]!, ...patch }
  saveSchedules(state)
  return state.schedules[i]!
}

export function deleteSchedule(id: string): boolean {
  const state = loadSchedules()
  const before = state.schedules.length
  state.schedules = state.schedules.filter((s) => s.id !== id)
  if (state.schedules.length === before) return false
  saveSchedules(state)
  return true
}

/** Append a run record + roll oldest off the cap. Also stamps
 * lastRunAt / lastResultPreview / lastError on the schedule itself. */
export function recordRun(
  scheduleId: string,
  outcome: {
    ok: boolean
    resultPreview: string
    errorMsg?: string
    startedAt: Date
    endedAt: Date
    claudeUuid?: string
  },
): void {
  const state = loadSchedules()
  const s = state.schedules.find((x) => x.id === scheduleId)
  if (!s) return

  const record: ScheduleRunRecord = {
    id: randomUUID(),
    scheduleId,
    scheduleName: s.name,
    startedAt: outcome.startedAt.toISOString(),
    endedAt: outcome.endedAt.toISOString(),
    ok: outcome.ok,
    durationMs: outcome.endedAt.getTime() - outcome.startedAt.getTime(),
    resultPreview: outcome.resultPreview,
    errorMsg: outcome.errorMsg,
    claudeUuid: outcome.claudeUuid,
  }
  state.history.unshift(record)
  if (state.history.length > HISTORY_CAP) {
    state.history.length = HISTORY_CAP
  }

  s.lastRunAt = outcome.endedAt.toISOString()
  s.lastResultPreview = outcome.resultPreview
  s.lastError = outcome.ok ? undefined : outcome.errorMsg

  saveSchedules(state)
}
