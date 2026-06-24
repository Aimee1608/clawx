// Thin fetch wrappers around the embedded backend at the same origin.
// During `vite dev`, requests go through the dev-server proxy defined in
// vite.config.ts; in production (served by src/web.ts) same-origin is
// automatic.

export interface StatusResponse {
  mode: 'hub' | 'ws'
  instanceId: string
  uptimeSec: number
  pid: number
  bindHost: string
}

export interface MaskedSecret {
  preview: string
  set: boolean
}

export interface MaskedConfig {
  claudeCwd?: string
  claudeCmd?: string
  larkAppId?: string
  larkAppSecret: MaskedSecret
  tmuxThreadChatId?: string
}

export interface ConfigResponse {
  path: string
  config: MaskedConfig
}

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}

export interface UiMessage {
  role: 'user' | 'assistant'
  text: string
  timestamp: string
  uuid: string
  isError?: boolean
}

export interface MessagesResponse {
  messages: UiMessage[]
  path: string
  note?: string
  /** Jsonl mtime in ms-since-epoch. Compare against `nowMs` to detect
   * whether the session has been written to recently (i.e. some other
   * process may be actively running this session). */
  lastModifiedMs?: number
  /** Server time when this response was built — pair with lastModifiedMs
   * to avoid client/server clock skew in the staleness check. */
  nowMs?: number
}

export interface ReplyResponse {
  ok: boolean
  response?: string
  durationMs?: number
  error?: string
}

export interface TmuxSessionEntry {
  sessionId: string
  tmuxName: string
  cwd: string
  agentKind?: 'claude' | 'codex'
  agentSessionId?: string
  transcriptPath?: string
  agentSessionPending?: boolean
  claudeUuid?: string
  threadId?: string
  chatId?: string
  rootMessageId?: string
  createdAt: string
  lastTurnAt?: string
  label?: string
}

export interface TmuxListResponse {
  sessions: TmuxSessionEntry[]
}

/** Coarse live status for a tmux session, from /api/tmux-sessions/states.
 * `status` is what the dashboard card badge renders; `repl` is the finer
 * REPL classification it's derived from. */
export interface TmuxSessionState {
  sessionId: string
  status: 'working' | 'idle' | 'stuck' | 'offline'
  repl: string
  alive: boolean
  working: boolean
}

export interface TmuxStatesResponse {
  states: TmuxSessionState[]
}

export interface TmuxCreateBody {
  cwd: string
  label?: string
  sessionId?: string
  agent?: 'claude' | 'codex'
}

export interface CwdSuggestion {
  cwd: string
  /** Where this suggestion came from. UI groups by this. */
  source: 'favorite' | 'scanned' | 'recent'
  /** Only set for `recent`. */
  lastUsedMs?: number
}

export interface ClaudeSessionMeta {
  uuid: string
  projectDir: string
  cwd?: string
  entrypoint?: string
  firstPrompt?: string
  firstTs?: string
  lastModified: string
  sizeBytes: number
  inBot: boolean
  /** When set, this session was spawned by a cron-engine `prompt` run with
   * the named schedule. Used by the All Claude Sessions UI to badge + filter. */
  scheduleName?: string
}

export interface AllClaudeSessionsResponse {
  sessions: ClaudeSessionMeta[]
  root: string
}

export interface CodexSessionMeta {
  id: string
  path: string
  cwd?: string
  createdAt?: string
  lastModified: string
  sizeBytes: number
}

export interface AllCodexSessionsResponse {
  sessions: CodexSessionMeta[]
  root: string
}

// ── Rooms ─────────────────────────────────────────────────────────

export type RoomStatus = 'starting' | 'running' | 'converged' | 'ended'

/** Trimmed projection of the backend RoomState — just the fields the
 * read-only rooms table renders (mirrors `clawx room ls`). */
export interface RoomMeta {
  id: string
  label: string
  status: RoomStatus
  cwd: string
  template?: string
  /** ms since epoch (RoomState.createdAt is a number, not an ISO string). */
  createdAt: number
  /** Lark topic thread id (topic mode only). */
  threadId?: string
}

export interface RoomsResponse {
  rooms: RoomMeta[]
}

// ── Schedules ─────────────────────────────────────────────────────

export type ScheduleKind = 'prompt' | 'message'

/** Agent backend for a `prompt` schedule. Defaults to 'claude' when absent. */
export type ScheduleAgentKind = 'claude' | 'codex'

export interface Schedule {
  id: string
  name: string
  /** Recurring cron expression. Mutually exclusive with `fireAt`. */
  cron?: string
  /** One-off fire timestamp (ISO). After firing the schedule auto-disables. */
  fireAt?: string
  /** Optional IANA timezone for `cron`. Ignored for `fireAt`. */
  timezone?: string
  kind: ScheduleKind
  /** Agent backend for `kind: 'prompt'`. Absent → 'claude'. */
  agentKind?: ScheduleAgentKind
  payload: string
  cwd?: string
  /** Bind a `prompt` schedule to an existing tmux session — when set,
   * cron dispatches the payload via send-keys instead of spawning a
   * one-shot claude --print, and the reply surfaces in the session's
   * Lark thread (not a DM). */
  tmuxSessionId?: string
  enabled: boolean
  createdAt: string
  lastRunAt?: string
  lastResultPreview?: string
  lastError?: string
  /** Server-computed next 3 fire times (ISO). For one-off, at most one entry. */
  nextRuns?: string[]
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
  /** claude UUID this run wrote to. Only set for `prompt` kind. */
  claudeUuid?: string
}

export interface SchedulesResponse {
  schedules: Schedule[]
  history: ScheduleRunRecord[]
}

export interface CreateScheduleBody {
  name: string
  cron?: string
  fireAt?: string
  timezone?: string
  kind: ScheduleKind
  agentKind?: ScheduleAgentKind
  payload: string
  cwd?: string
  tmuxSessionId?: string
  enabled?: boolean
}

export type UpdateScheduleBody = Partial<Omit<Schedule, 'id' | 'createdAt' | 'nextRuns'>>

export interface CronPreviewBody {
  cron?: string
  fireAt?: string
  timezone?: string
}

export interface CronPreviewResponse {
  valid: boolean
  nextRuns?: string[]
  error?: string
}


export const api = {
  status: () => fetch('/api/status').then((r) => j<StatusResponse>(r)),
  config: () => fetch('/api/config').then((r) => j<ConfigResponse>(r)),
  saveConfig: (body: Record<string, string>) =>
    fetch('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => j<{ path: string; saved: boolean }>(r)),
  allClaudeSessions: () => fetch('/api/claude-sessions/all').then((r) => j<AllClaudeSessionsResponse>(r)),
  allCodexSessions: () => fetch('/api/codex-sessions/all').then((r) => j<AllCodexSessionsResponse>(r)),
  rooms: () => fetch('/api/rooms').then((r) => j<RoomsResponse>(r)),
  claudeSessionMessages: (uuid: string) =>
    fetch(`/api/claude-sessions/${encodeURIComponent(uuid)}/messages`).then((r) => j<MessagesResponse>(r)),
  agentSessionMessages: (kind: 'claude' | 'codex', id: string) =>
    fetch(`/api/agent-sessions/${kind}/${encodeURIComponent(id)}/messages`).then((r) => j<MessagesResponse>(r)),
  replyToSession: (uuid: string, prompt: string) =>
    fetch(`/api/claude-sessions/${encodeURIComponent(uuid)}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt }),
    }).then(async (r) => {
      // Always parse the body so callers can read `error` on non-2xx.
      const body = (await r.json().catch(() => null)) as ReplyResponse | null
      if (!r.ok) {
        return { ok: false, error: body?.error ?? `HTTP ${r.status}` } as ReplyResponse
      }
      return body ?? { ok: false, error: 'empty response' }
    }),

  // ── Tmux sessions ──────────────────────────────────────────────
  listTmuxSessions: () =>
    fetch('/api/tmux-sessions').then((r) => j<TmuxListResponse>(r)),
  tmuxSessionStates: () =>
    fetch('/api/tmux-sessions/states').then((r) => j<TmuxStatesResponse>(r)),
  createTmuxSession: (body: TmuxCreateBody) =>
    fetch('/api/tmux-sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Tag origin so the seed text says "来自 web" instead of "未知".
      body: JSON.stringify({ ...body, source: 'web' }),
    }).then(async (r) => {
      const data = (await r.json().catch(() => null)) as
        | { ok: boolean; entry?: TmuxSessionEntry; error?: string }
        | null
      if (!r.ok) return { ok: false, error: data?.error ?? `HTTP ${r.status}` }
      return data ?? { ok: false, error: 'empty response' }
    }),
  sendToTmuxSession: (sid: string, text: string) =>
    fetch(`/api/tmux-sessions/${encodeURIComponent(sid)}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Tag origin so turn-done's fanout prefixes the echo with [web].
      body: JSON.stringify({ text, source: 'web' }),
    }).then(async (r) => {
      const data = (await r.json().catch(() => null)) as
        | { ok: boolean; error?: string }
        | null
      if (!r.ok) return { ok: false, error: data?.error ?? `HTTP ${r.status}` }
      return data ?? { ok: false, error: 'empty response' }
    }),
  captureTmuxSession: (sid: string) =>
    fetch(`/api/tmux-sessions/${encodeURIComponent(sid)}/capture`).then(
      async (r) => {
        const data = (await r.json().catch(() => null)) as
          | { ok: boolean; text?: string; error?: string }
          | null
        if (!r.ok) return { ok: false, error: data?.error ?? `HTTP ${r.status}` }
        return data ?? { ok: false, error: 'empty response' }
      },
    ),
  cwdSuggestions: () =>
    fetch('/api/cwd-suggestions').then((r) => j<{ suggestions: CwdSuggestion[] }>(r)),
  addCwdFavorite: (cwd: string) =>
    fetch('/api/cwd-favorites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd }),
    }).then(async (r) => {
      const data = (await r.json().catch(() => null)) as
        | { ok: boolean; favorites?: string[]; error?: string }
        | null
      if (!r.ok) return { ok: false, error: data?.error ?? `HTTP ${r.status}` }
      return data ?? { ok: false, error: 'empty response' }
    }),
  removeCwdFavorite: (cwd: string) =>
    fetch('/api/cwd-favorites', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd }),
    }).then(async (r) => {
      const data = (await r.json().catch(() => null)) as
        | { ok: boolean; favorites?: string[]; error?: string }
        | null
      if (!r.ok) return { ok: false, error: data?.error ?? `HTTP ${r.status}` }
      return data ?? { ok: false, error: 'empty response' }
    }),
  killTmuxSession: (sid: string) =>
    fetch(`/api/tmux-sessions/${encodeURIComponent(sid)}`, {
      method: 'DELETE',
    }).then(async (r) => {
      const data = (await r.json().catch(() => null)) as
        | { ok: boolean; error?: string }
        | null
      if (!r.ok) return { ok: false, error: data?.error ?? `HTTP ${r.status}` }
      return data ?? { ok: false, error: 'empty response' }
    }),

  // ── Schedules ──────────────────────────────────────────────────

  schedules: () => fetch('/api/schedules').then((r) => j<SchedulesResponse>(r)),
  createSchedule: (body: CreateScheduleBody) =>
    fetch('/api/schedules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => j<{ schedule: Schedule }>(r)),
  updateSchedule: (id: string, body: UpdateScheduleBody) =>
    fetch(`/api/schedules/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => j<{ schedule: Schedule }>(r)),
  deleteSchedule: (id: string) =>
    fetch(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) =>
      j<{ ok: boolean }>(r),
    ),
  runScheduleNow: (id: string) =>
    fetch(`/api/schedules/${encodeURIComponent(id)}/run-now`, { method: 'POST' }).then((r) =>
      j<{ ok: boolean }>(r),
    ),
  cronPreview: (body: CronPreviewBody) =>
    fetch('/api/cron/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(async (r) => {
        // Return the body even on 400 because the form needs to display the
        // validation error inline rather than throw.
        const data = (await r.json().catch(() => ({}))) as CronPreviewResponse
        return data
      }),

}
