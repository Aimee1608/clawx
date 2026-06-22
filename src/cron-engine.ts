import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClaudeHandle } from './claude-runner.js'
import {
  isDue,
  isOneOff,
  loadSchedules,
  recordRun,
  updateSchedule,
  type Schedule,
} from './schedule-store.js'
import type { PushSender } from './push-sender.js'
import { log } from './logger.js'

export interface CronEngineOptions {
  pushSender: PushSender
  /** Default cwd for `prompt` schedules whose `cwd` field is unset. Usually `cfg.claudeCwd`. */
  defaultCwd: string
  /** Default claude binary. Usually `cfg.claudeCmd`. */
  defaultCmd: string
  /** Per-claude-prompt timeout. Usually 3-5 min. */
  promptTimeoutMs: number
  /** Tick interval. Default 60s. Schedules with sub-minute cron precision
   * still resolve correctly because cron-parser-emitted timestamps fall
   * within the most recent tick window. */
  intervalMs?: number
  /** Cap on the message body sent to the user, to avoid Lark choking on
   * a 50KB claude transcript. Default 4000 chars. */
  pushBodyMaxChars?: number
  /** Cap on the lastResultPreview field stored back into schedules.json.
   * Default 200 chars. Just enough for the UI to show "what happened". */
  previewMaxChars?: number
  /** Optional tmux dispatcher. When provided AND a schedule has
   * `tmuxSessionId`, cron sends the payload via send-keys into that
   * pane instead of spawning a one-shot `claude --print`. The reply
   * flows back through the Stop hook → Lark thread; no DM push. */
  tmuxDispatch?: (sessionId: string, text: string) => Promise<void>
}

export interface CronEngineHandle {
  stop: () => void
  /** Manually run a schedule immediately (used by POST /api/schedules/:id/run-now). */
  runNow: (id: string) => Promise<void>
}

/**
 * Cron-driven scheduler: ticks every minute, fires due schedules, runs
 * the appropriate runner (prompt / message / scan), DM's the user, and
 * records the result.
 *
 * Distinct from `scheduler.ts` (the attention-needed push):
 *   - `scheduler.ts` is automatic surveillance (no user config) — emits
 *     a notification when host-state crosses a threshold.
 *   - `cron-engine.ts` is user-defined recurring tasks — fires each
 *     schedule when its cron expression matches.
 */
export function startCronEngine(opts: CronEngineOptions): CronEngineHandle {
  const intervalMs = opts.intervalMs ?? 60_000
  const promptTimeoutMs = opts.promptTimeoutMs ?? 180_000
  const pushCap = opts.pushBodyMaxChars ?? 4000
  const previewCap = opts.previewMaxChars ?? 200

  log.info('cron engine armed', { intervalMin: Math.round(intervalMs / 60_000) })

  let stopped = false
  const inflight = new Set<string>()

  async function fire(s: Schedule): Promise<void> {
    if (inflight.has(s.id)) {
      log.debug('cron skip (already inflight)', { id: s.id, name: s.name })
      return
    }
    inflight.add(s.id)
    const startedAt = new Date()
    let resultPreview = ''
    let pushBody = ''
    let ok = true
    let errorMsg: string | undefined
    // Pre-allocate a claude UUID for claude-backed `prompt` kind so we can
    // record the transcript linkage even if the run later fails. `message`
    // and codex-backed prompts don't get one (codex transcripts don't live
    // under ~/.claude/projects, and there's no --session-id to pin).
    const claudeUuid =
      s.kind === 'prompt' && (s.agentKind ?? 'claude') === 'claude' ? randomUUID() : undefined

    // tmux-routed: dispatch to the bound session's claude REPL via
    // send-keys. We don't await a reply here — Stop hook will surface
    // it in the session's Lark thread. We also skip the DM push since
    // the result will already be visible to the operator in-thread.
    // Only claude-backed prompts route through tmux (the bound REPL is a
    // claude session); codex prompts always run standalone.
    const useTmux =
      s.kind === 'prompt' &&
      (s.agentKind ?? 'claude') === 'claude' &&
      !!s.tmuxSessionId?.trim() &&
      !!opts.tmuxDispatch

    try {
      log.info('cron fire', {
        id: s.id,
        name: s.name,
        kind: s.kind,
        route: useTmux ? `tmux:${s.tmuxSessionId}` : 'standalone',
      })
      if (useTmux) {
        await opts.tmuxDispatch!(s.tmuxSessionId!.trim(), s.payload)
        resultPreview = `→ tmux ${s.tmuxSessionId!.slice(0, 12)} (reply in thread)`
        pushBody = '' // no DM — thread fanout handles surfacing
      } else {
        const text = await runOne(s, {
          defaultCwd: opts.defaultCwd,
          defaultCmd: opts.defaultCmd,
          promptTimeoutMs,
          claudeUuid,
        })
        resultPreview = text.slice(0, previewCap).trim()
        pushBody = formatPushBody(s, text, pushCap)
      }
    } catch (err: any) {
      ok = false
      errorMsg = err?.message ?? String(err)
      resultPreview = errorMsg!.slice(0, previewCap)
      pushBody = `🚨 schedule "${s.name}" 失败:\n${errorMsg}`
      log.error('cron fire failed', { id: s.id, name: s.name, err: errorMsg })
    } finally {
      const endedAt = new Date()
      recordRun(s.id, { ok, resultPreview, errorMsg, startedAt, endedAt, claudeUuid })
      // One-off schedules auto-disable after a single fire so the cron
      // engine doesn't try to refire them on subsequent ticks (isDue
      // already short-circuits via lastRunAt, but flipping `enabled`
      // makes the UI obviously reflect "this fired once and is done").
      if (isOneOff(s)) {
        updateSchedule(s.id, { enabled: false })
      }
      inflight.delete(s.id)
    }

    // Push outside the inflight try-block so a push failure doesn't
    // overwrite the actual run outcome in our records. Skip when
    // tmux-routed (the body is empty and thread fanout handles it).
    if (pushBody.trim()) {
      try {
        await opts.pushSender.send(pushBody)
      } catch (err) {
        log.warn('cron push failed', {
          id: s.id,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  const tick = async (): Promise<void> => {
    if (stopped) return
    try {
      const state = loadSchedules()
      const now = new Date()
      for (const s of state.schedules) {
        if (!isDue(s, now)) continue
        // Don't await: let independent schedules fire in parallel.
        void fire(s)
      }
    } catch (err: any) {
      log.error('cron tick error', { err: err?.message ?? String(err) })
    }
  }

  // Fire the first tick after a short delay so startup logs aren't
  // drowned by a bunch of due-schedule firings.
  const initialDelay = setTimeout(() => void tick(), 15_000)
  const interval = setInterval(() => void tick(), intervalMs)

  return {
    stop: () => {
      stopped = true
      clearTimeout(initialDelay)
      clearInterval(interval)
    },
    runNow: async (id: string) => {
      const state = loadSchedules()
      const s = state.schedules.find((x) => x.id === id)
      if (!s) throw new Error(`schedule ${id} not found`)
      await fire(s)
    },
  }
}

// ── Runner dispatch ──────────────────────────────────────────────

interface RunnerCtx {
  defaultCwd: string
  defaultCmd: string
  promptTimeoutMs: number
  /** Pre-allocated UUID for `prompt` kind so the caller can persist the
   * linkage to schedule history. Ignored for non-`prompt` kinds. */
  claudeUuid?: string
}

async function runOne(s: Schedule, ctx: RunnerCtx): Promise<string> {
  if (s.kind === 'message') {
    return s.payload
  }
  if (s.kind === 'prompt') {
    const cwd = s.cwd?.trim() || ctx.defaultCwd
    if ((s.agentKind ?? 'claude') === 'codex') {
      return runCodexPrompt(s.payload, cwd, ctx.promptTimeoutMs)
    }
    const handle = createClaudeHandle()
    const text = await handle.run(s.payload, {
      cmd: ctx.defaultCmd,
      cwd,
      // We always start a fresh claude session for scheduled prompts —
      // schedules aren't conversational, each run is independent.
      sessionId: ctx.claudeUuid ?? randomUUID(),
      isNewSession: true,
      timeoutMs: ctx.promptTimeoutMs,
    })
    return text
  }
  // 'scan' kind was removed when the manager-subsystem was retired.
  // Existing schedules with that kind will surface here as an explicit
  // error so the operator can migrate them.
  throw new Error(`unsupported schedule kind: ${s.kind}`)
}

/**
 * Run a scheduled `prompt` against codex via a one-shot `codex exec`.
 *
 * Mirrors src/room/codex-review.ts's invocation exactly (the answer is
 * captured from an `-o <file>` outfile because codex's stdout interleaves
 * version / workdir / token noise that's unreliable to parse). Each run is
 * `--ephemeral` (no persisted session) since schedules aren't
 * conversational, and `--skip-git-repo-check` tolerates a non-git cwd.
 *
 * Rejects on timeout / spawn error / empty output so the cron `fire()`
 * try-block records it as a failed run and DMs the error — same contract
 * as the claude path (which throws on failure).
 */
function runCodexPrompt(payload: string, cwd: string, timeoutMs: number): Promise<string> {
  const codexCmd = process.env.CODEX_CMD?.trim() || 'codex'
  const outFile = path.join(os.tmpdir(), `clawx-codex-schedule-${randomUUID().slice(0, 8)}.txt`)

  return new Promise<string>((resolve, reject) => {
    let settled = false
    const finish = (err: Error | null, text: string): void => {
      if (settled) return
      settled = true
      try {
        fs.rmSync(outFile, { force: true })
      } catch {
        /* best-effort cleanup */
      }
      if (err) reject(err)
      else resolve(text)
    }

    const child = spawn(
      codexCmd,
      [
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
        '--ephemeral',
        '-C',
        cwd,
        '-o',
        outFile,
        payload,
      ],
      // stdin ignored so codex doesn't block on it; stdout carries noisy
      // progress we don't read (answer comes from -o); stderr kept for
      // diagnostics on failure.
      { cwd, env: process.env, stdio: ['ignore', 'ignore', 'pipe'] },
    )

    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(new Error('codex schedule run timed out'), '')
    }, timeoutMs)

    child.stderr?.on('data', (d) => (stderr += String(d)))
    child.on('error', (e) => {
      clearTimeout(timer)
      finish(e, '')
    })
    child.on('close', () => {
      clearTimeout(timer)
      let text = ''
      try {
        text = fs.readFileSync(outFile, 'utf8').trim()
      } catch {
        /* no output file produced */
      }
      if (!text) {
        finish(new Error(stderr.trim().slice(-400) || 'codex produced no output'), '')
        return
      }
      finish(null, text)
    })
  })
}

function formatPushBody(s: Schedule, raw: string, cap: number): string {
  const truncated = raw.length > cap ? `${raw.slice(0, cap)}\n\n…(truncated, ${raw.length - cap} more chars)` : raw
  const agent = (s.agentKind ?? 'claude') === 'codex' ? 'codex' : 'claude'
  const head = s.kind === 'prompt' ? `🤖 schedule · ${s.name} (${agent})` : `🔔 ${s.name}`
  return `${head}\n\n${truncated}`
}
