import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { SessionStore } from './session-store.js'
import {
  loadUserConfigFile,
  addCwdFavorite,
  removeCwdFavorite,
  expandHomePath,
  configDir,
  type UserConfigFile,
} from './config.js'
import { log } from './logger.js'
import { normalizeAgentKind, type AgentKind } from './agent-backend.js'
import {
  scanAllClaudeSessions,
  readMessagesByUuidFromProjects,
  readClaudeMessages,
  readClaudeMessagesFromRaw,
  claudeProjectsRoot,
  locateSession,
  type ClaudeSessionMeta,
  type UiMessage,
} from './claude-sessions.js'
import {
  readCodexMessagesFromRaw,
  locateCodexSession,
  readMessagesByCodexSessionId,
  scanAllCodexSessions,
  codexSessionsRoot,
} from './codex-sessions.js'
import { createClaudeHandle } from './claude-runner.js'
import {
  formatSeedText,
  buildForwardCard,
  buildAskQuestionCard,
  type AskQuestionItem,
} from './seed-text.js'
import {
  loadSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  validateCron,
  validateTrigger,
  nextFireTimes,
  type CreateScheduleInput,
  type ScheduleKind,
  type UpdateScheduleInput,
} from './schedule-store.js'
import type { CronEngineHandle } from './cron-engine.js'
import { TmuxSessionStore, type TmuxSessionEntry } from './tmux-session-store.js'
import { createTmuxOrchestrator, type TmuxOrchestrator, type SendSource } from './tmux-orchestrator.js'
import { classifyReplState } from './repl-watchdog.js'
import type { LarkThreadService } from './lark-thread.js'
import { listRooms } from './room/room-store.js'

export interface WebServerOptions {
  /** Optional cron engine handle. When set, the schedule API endpoints
   * become available (POST /run-now in particular needs this). When
   * unset, those endpoints respond 503. */
  cronEngine?: CronEngineHandle | null
  /**
   * Directory the claude subprocess runs in. Used to resolve the per-session
   * jsonl files at ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl when serving
   * GET /api/sessions/:uuid/messages.
   */
  claudeCwd: string
  port: number
  /**
   * Interface to bind. Defaults to `0.0.0.0` so VS Code Remote / SSH users
   * can reach the UI at `http://<dev-box-ip>:<port>/` directly. Override
   * with `CLAWX_WEB_HOST=127.0.0.1` to restrict to localhost.
   *
   * Security caveat: the UI exposes `POST /api/config` with no auth,
   * which can write / overwrite secret fields in the user's config file.
   * Keep the bot credentials stored only on trusted boxes, or bind to
   * `127.0.0.1` and tunnel (ssh -L, VS Code port forward) for access.
   */
  host?: string
  sessionStore: SessionStore
  mode: 'hub' | 'ws'
  instanceId: string
  /** Optional PushSender for Feature Workflow notifications. When unset,
   * a NullPushSender is used (notifications log only, don't DM). Hub /
   * WS modes wire their concrete senders in. */
  pushSender?: import('./push-sender.js').PushSender
  /** Public-facing URL for deep links inside DMs. Defaults to the
   * value of CLAWX_WEB_PUBLIC_URL env. */
  webBaseUrl?: string
  /** Optional pre-built tmux session store. When omitted, a fresh
   * default-path-backed instance is created. WS mode injects its own
   * so the same in-memory state is shared between the /new-tmux
   * command handler and the /api/internal/turn-done handler. */
  tmuxSessionStore?: TmuxSessionStore
  /** Optional pre-built tmux orchestrator. Same sharing rationale. */
  tmuxOrchestrator?: TmuxOrchestrator
  /** Fanout callback invoked from /api/internal/turn-done after the
   * jsonl is parsed. Errors here are logged but do NOT fail the hook
   * — the bot stays alive.
   *
   * - `assistantText`: ALL assistant blocks emitted since the previous
   *   turn-done, joined with blank lines. Handles claude's "I'll check
   *   X / [tool] / found Y" multi-block turns so the thread sees the
   *   whole answer instead of just the final block.
   * - `userText`: the user's most-recent typed message (the one that
   *   triggered this turn), or null if we can't identify it.
   * - `userSource`: where the user's text came from. 'lark' means it
   *   was typed in the thread directly and should NOT be echoed (else
   *   we'd duplicate). Other sources should be tagged in the echo.
   */
  tmuxFanout?: (args: {
    entry: TmuxSessionEntry
    assistantText: string | null
    userText: string | null
    userSource: SendSource
    messageCount: number
  }) => Promise<void> | void
  /** Streams a single INTERMEDIATE assistant block to the thread mid-turn
   * (opt-in via CLAWX_STREAM_REPLIES). Called per settled non-final block as
   * it lands in the transcript; the final block still goes through tmuxFanout
   * at turn-done, so the two are disjoint. Best-effort — errors are logged,
   * never block the turn. */
  tmuxStreamBlock?: (args: { entry: TmuxSessionEntry; text: string }) => Promise<void> | void
  /** Lark thread helper. When wired (WS mode), the POST
   * /api/tmux-sessions endpoint auto-creates a Lark thread for each
   * new session so bot/web/cli all yield uniformly-routable sessions.
   * When omitted, the endpoint still creates the tmux session but the
   * entry's threadId/chatId remain empty. */
  larkThread?: LarkThreadService
  /** Default chat_id for thread creation when caller doesn't override
   * per request. Falls back to env CLAWX_TMUX_THREAD_CHAT_ID at the
   * call site if unset here. */
  tmuxThreadChatId?: string
  /** Named topic groups for `--group <name>` (config `tmuxThreadChats`).
   * A create request with `group: "<name>"` resolves its chat_id here;
   * no group → the default `tmuxThreadChatId`. */
  tmuxThreadChats?: Record<string, string>
  /** Lark emoji_type used by the PreToolUse-driven progress reaction.
   * Defaults to "HOURGLASS"; a few Lark workspaces normalize differently
   * so it's tunable from UserConfig. */
  tmuxProgressEmoji?: string
  /** Operator's Lark open_id. When set, new-session seed messages
   * @-mention this user so they auto-subscribe to the topic. Can be a
   * static string OR a callback for "live" reads — needed because the
   * daemon auto-discovers the openId on first DM and writes it to
   * config, and the web server captured opts at startup. Callback lets
   * subsequent create-session calls pick up the freshly-saved value
   * without a daemon restart. */
  userOpenId?: string | (() => string | undefined)
}

// ── User config file read/write ────────────────────────────────────

function userConfigPath(): string {
  return path.join(configDir(), 'config.json')
}

function writeUserConfigFile(cfg: UserConfigFile): void {
  const p = userConfigPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
}

// Strip the long half of secret-looking values so the UI can display a
// "secret already set" hint without leaking the value back. Kept 6 chars
// as a recognizable preview.
function maskSecret(val: string | undefined): { preview: string; set: boolean } {
  if (!val || val.length === 0) return { preview: '', set: false }
  return { preview: val.slice(0, 6) + '…', set: true }
}

interface MaskedConfigView {
  claudeCwd?: string
  claudeCmd?: string
  larkAppId?: string
  larkAppSecret: { preview: string; set: boolean }
  tmuxThreadChatId?: string
}

function maskConfigForView(cfg: UserConfigFile): MaskedConfigView {
  return {
    claudeCwd: cfg.claudeCwd,
    claudeCmd: cfg.claudeCmd,
    larkAppId: cfg.larkAppId,
    larkAppSecret: maskSecret(cfg.larkAppSecret),
    tmuxThreadChatId: cfg.tmuxThreadChatId,
  }
}

// ── Static asset serving ──────────────────────────────────────────
// The Semi UI SPA is pre-built by `pnpm -C web build` and dropped into
// ../dist/web-assets/ relative to this file's compiled location.
// At install-time, the package ships `dist/` whole, so dist/web-assets/
// sits alongside dist/web.js.
//
// Dev note: during `tsx watch src/cli.ts start`, web-assets/ exists only
// if you've run `pnpm -C web build` at least once. Without it the API
// still works; the UI just 404s. Use `pnpm -C web dev` on :5173 to
// iterate the frontend with Vite's HMR (proxy forwards /api to :8124).

function assetsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  // Production layout (dist/web.js → dist/web-assets/)
  const prod = path.resolve(here, 'web-assets')
  if (fs.existsSync(prod)) return prod
  // Dev fallback (src/web.ts → ../dist/web-assets/)
  const dev = path.resolve(here, '..', 'dist', 'web-assets')
  return dev
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
}

function safeResolveAsset(reqPath: string, root: string): string | null {
  // Strip query string + normalize; block path traversal by requiring the
  // resolved path to stay within `root`.
  const clean = reqPath.split('?')[0]!.split('#')[0]!.replace(/^\/+/, '')
  const abs = path.resolve(root, clean || 'index.html')
  if (!abs.startsWith(root + path.sep) && abs !== root) return null
  return abs
}

function serveStatic(res: http.ServerResponse, absPath: string): boolean {
  try {
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return false
    const ext = path.extname(absPath).toLowerCase()
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
    })
    fs.createReadStream(absPath).pipe(res)
    return true
  } catch {
    return false
  }
}

const HTML_FALLBACK_404 = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>clawx — web assets missing</title></head>
<body style="font-family: -apple-system, sans-serif; padding: 2rem; max-width: 640px; margin: 0 auto;">
<h1>clawx web UI not built</h1>
<p>The API is running but the frontend bundle at <code>dist/web-assets/</code>
is missing.</p>
<p>If you're developing locally, run:</p>
<pre style="background: #eee; padding: 1rem;">pnpm -C web build</pre>
<p>Or use the Vite dev server instead: <code>pnpm -C web dev</code> (listens on
:5173, proxies /api to this server).</p>
</body>
</html>`


// ── HTTP server ────────────────────────────────────────────────────

function readJsonBody(req: http.IncomingMessage, cap = 32 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > cap) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? JSON.parse(text) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function locateAgentTranscript(
  kind: AgentKind,
  id: string | undefined,
  fallback?: string,
): { jsonlPath: string; cwd?: string } | null {
  if (fallback && fs.existsSync(fallback)) return { jsonlPath: fallback }
  if (!id) return null
  return kind === 'codex' ? locateCodexSession(id) : locateSession(id)
}

function readAgentMessagesById(
  kind: AgentKind,
  id: string,
): { messages: UiMessage[]; path: string; lastModifiedMs: number } | null {
  return kind === 'codex'
    ? readMessagesByCodexSessionId(id)
    : readMessagesByUuidFromProjects(id)
}

/** Human label for a SendSource — used in Lark seed text + per-turn
 * echoes. Keep these short so they fit on one row. */
// formatSeedText and sourceLabel live in src/seed-text.ts so the Lark
// /new-tmux command handler can render the same surface.

/**
 * @deprecated retained only to avoid breaking external callers; the
 * turn-done retry loop now derives the "complete on disk" signal from
 * the same readClaudeMessagesFromRaw call that gathers messages, so
 * the two reads stay consistent. See web.ts turn-done handler.
 */
function jsonlHasEndTurnAfter(jsonlPath: string, sinceMs: number): boolean {
  let raw: string
  try {
    raw = fs.readFileSync(jsonlPath, 'utf8')
  } catch {
    return false
  }
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.trim()) continue
    if (!line.includes('"stop_reason":"end_turn"')) continue
    let rec: any
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (rec.type !== 'assistant') continue
    const ts = Date.parse(String(rec.timestamp ?? '')) || 0
    if (ts > sinceMs) return true
  }
  return false
}

/**
 * Decide whether a turn is "synthetic" — i.e. internal Task() sub-agent
 * bookkeeping that we should NOT push to the Lark thread.
 *
 * Subtle: a Task() finish triggers a Stop hook in the MAIN claude with
 *   userText = "<task-notification>...<task-id>..."
 *   assistantText = whatever main-claude wrote right after
 *
 * Two distinct cases that both look "synthetic" at first glance:
 *   1) intermediate ack — main-claude says "okay, continuing" (~20-50
 *      chars) before kicking off more tools. Skip — pure noise.
 *   2) FINAL summary — sub-agent finished, main-claude writes the
 *      substantive answer (~hundreds to thousands of chars). KEEP —
 *      this is the user-facing result they're waiting for.
 *
 * Heuristic: only skip when the assistant reply is short. Threshold
 * 200 chars is well below typical task summaries (300+) and well above
 * pure acks (<100). Tune if false-positives recur.
 */
const SYNTHETIC_ACK_MAX_CHARS = 200

function isSyntheticTurn(userText: string | null, assistantText: string | null): boolean {
  const u = userText?.trim() ?? ''
  const aLen = assistantText?.length ?? 0
  const userLooksSynthetic =
    u.startsWith('<task-notification>') || /<task-id>/i.test(u)
  if (userLooksSynthetic && aLen <= SYNTHETIC_ACK_MAX_CHARS) return true
  if (!u && aLen < 80) return true
  return false
}

function validateScheduleInput(
  b: Partial<CreateScheduleInput>,
  knownTmuxSessionIds: Set<string>,
): string | null {
  if (!b || typeof b !== 'object') return 'request body must be a JSON object'
  if (!b.name || typeof b.name !== 'string' || !b.name.trim()) return 'name is required'
  const triggerErr = validateTrigger({
    cron: typeof b.cron === 'string' ? b.cron : undefined,
    fireAt: typeof b.fireAt === 'string' ? b.fireAt : undefined,
    timezone: typeof b.timezone === 'string' ? b.timezone : undefined,
  })
  if (triggerErr) return triggerErr
  const validKinds: ScheduleKind[] = ['prompt', 'message']
  if (!validKinds.includes(b.kind as ScheduleKind)) {
    return `kind must be one of ${validKinds.join(' / ')}`
  }
  if (b.agentKind !== undefined && b.agentKind !== null) {
    if (b.agentKind !== 'claude' && b.agentKind !== 'codex') {
      return 'agentKind must be "claude" or "codex"'
    }
    if (b.kind !== 'prompt' && b.agentKind === 'codex') {
      return 'agentKind is only valid for kind=prompt schedules'
    }
  }
  if (typeof b.payload !== 'string') return 'payload must be a string'
  if (!b.payload.trim()) return 'payload is required'
  if (b.tmuxSessionId !== undefined && b.tmuxSessionId !== null) {
    if (typeof b.tmuxSessionId !== 'string') return 'tmuxSessionId must be a string'
    const sid = b.tmuxSessionId.trim()
    if (sid) {
      if (b.kind !== 'prompt') {
        return 'tmuxSessionId is only valid for kind=prompt schedules'
      }
      if (!knownTmuxSessionIds.has(sid)) {
        return `tmuxSessionId "${sid}" is not a live clawx tmux session`
      }
    }
  }
  return null
}


export function startWebServer(opts: WebServerOptions): http.Server {
  const startedAt = Date.now()
  const ASSETS_ROOT = assetsDir()
  const boundHost = opts.host ?? '0.0.0.0'

  // ── tmux session store (Phase 1 of multi-end-sync feature) ───────
  // Lives at ~/.local/share/clawx/tmux-sessions.json. Used by the
  // /api/internal/turn-done endpoint to look up which clawx session
  // owns a given claude UUID; the Stop-hook shim writes here-ish
  // (reads it directly without going through the store).
  const tmuxSessionStore = opts.tmuxSessionStore ?? new TmuxSessionStore()
  const tmuxOrchestrator =
    opts.tmuxOrchestrator ?? createTmuxOrchestrator({ store: tmuxSessionStore })

  // Serialize turn-done per (agentKind, session) so the sinceMs/lastTurnAt
  // dedup that's meant to make a replayed turn-done a no-op actually holds.
  // Two paths can fire turn-done for the SAME turn near-simultaneously — the
  // agent's Stop hook AND the repl-watchdog's recovery — and each captures the
  // turn boundary (sinceMs) at its start, BEFORE the other commits the new
  // lastTurnAt. Without serialization both read the stale boundary and the
  // reply fans out to Lark twice (observed on codex, whose late Stop hook
  // races the watchdog recover). Keyed so different sessions still run
  // concurrently; same-session calls queue and the second sees the boundary
  // the first committed → its assistantText is empty → fanout is a no-op.
  const turnDoneTail = new Map<string, Promise<unknown>>()
  function serializeTurnDone<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = turnDoneTail.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn) // run regardless of the previous outcome
    const stored = run.then(
      () => {},
      () => {},
    )
    turnDoneTail.set(key, stored)
    void stored.then(() => {
      if (turnDoneTail.get(key) === stored) turnDoneTail.delete(key)
    })
    return run
  }

  // ── Mid-turn reply streaming (opt-in: CLAWX_STREAM_REPLIES) ──────────
  // claude appends each assistant message to its transcript jsonl as a
  // complete line while the turn runs (narration between tool calls, then
  // the final answer). By default the thread only gets the FINAL block at
  // turn-done. When enabled, a per-session poller tails the transcript and
  // streams each settled INTERMEDIATE block — any assistant block that
  // already has a newer line after it, so it's complete and not the in-flight
  // final. The final block is left to turn-done, so streamed + final are
  // disjoint and nothing is sent twice. claude only (codex's notify path is
  // more fragile and out of scope).
  const STREAM_ENABLED = /^(1|true|yes|on)$/i.test(process.env.CLAWX_STREAM_REPLIES ?? '')
  const STREAM_POLL_MS = Math.max(200, Number(process.env.CLAWX_STREAM_POLL_MS) || 700)
  const STREAM_MAX_MS = Math.max(60_000, Number(process.env.CLAWX_STREAM_MAX_MS) || 1_800_000)
  // Per poll we read only the LAST window of the transcript, not the whole
  // file — a long session's jsonl is multi-MB and re-reading it every poll
  // would churn CPU/GC. One turn's blocks always sit at the tail, and the
  // sinceMs + uuid filters drop anything older that the window happens to
  // include, so a bounded window is both cheap and correct.
  const STREAM_TAIL_BYTES = Math.max(64 * 1024, Number(process.env.CLAWX_STREAM_TAIL_BYTES) || 512 * 1024)
  interface ReplyStreamer {
    /** Stops the poll loop and resolves with the uuids already streamed, so
     * turn-done can exclude them and never re-send a block (robust even when
     * the final assistant block isn't the transcript's last line). */
    stop(): Promise<Set<string>>
  }
  const streamers = new Map<string, ReplyStreamer>()

  function stopReplyStreamer(sessionId: string): Promise<Set<string>> {
    const s = streamers.get(sessionId)
    if (!s) return Promise.resolve(new Set<string>())
    streamers.delete(sessionId)
    return s.stop()
  }

  function startReplyStreamer(entry: TmuxSessionEntry, sinceMs: number): void {
    if (!STREAM_ENABLED || (entry.agentKind ?? 'claude') !== 'claude' || !opts.tmuxStreamBlock) return
    const sessionId = entry.sessionId
    void stopReplyStreamer(sessionId) // a new turn supersedes the prior streamer
    const sent = new Set<string>()
    const deadline = Date.now() + STREAM_MAX_MS
    let active = true
    let lastSize = -1
    let inFlight: Promise<void> = Promise.resolve()
    // Identity token: ONLY the streamer currently registered in `streamers`
    // for this session may send. A superseded / orphaned streamer — left over
    // from a daemon restart, a supersede race, or a missed turn-done — sees it
    // is no longer the registered one and bails, so two streamers can never
    // double-post the same turn.
    const self: ReplyStreamer = {
      stop: async () => {
        active = false
        try {
          await inFlight
        } catch {
          /* ignore */
        }
        return sent
      },
    }
    streamers.set(sessionId, self)
    const isCurrent = (): boolean => streamers.get(sessionId) === self
    const tick = async (): Promise<void> => {
      if (!isCurrent()) {
        active = false
        return
      }
      const located = locateAgentTranscript(
        'claude',
        entry.claudeUuid ?? entry.agentSessionId,
        entry.transcriptPath,
      )
      if (!located?.jsonlPath) return
      let size = 0
      try {
        size = fs.statSync(located.jsonlPath).size
      } catch {
        return // file not there yet / vanished — skip this round
      }
      if (size === lastSize) return // nothing appended since last poll
      lastSize = size
      const start = Math.max(0, size - STREAM_TAIL_BYTES)
      let raw = ''
      try {
        const fd = fs.openSync(located.jsonlPath, 'r')
        try {
          const len = size - start
          const buf = Buffer.alloc(len)
          fs.readSync(fd, buf, 0, len, start)
          raw = buf.toString('utf8')
        } finally {
          fs.closeSync(fd)
        }
      } catch {
        return
      }
      // If we started mid-file, the first line is a fragment — drop it.
      if (start > 0) {
        const nl = raw.indexOf('\n')
        raw = nl >= 0 ? raw.slice(nl + 1) : ''
      }
      // Candidate intermediate blocks: assistant, non-error, non-empty, past
      // the turn boundary. HOLD BACK the most recent assistant block — it's the
      // current/eventual final answer that turn-done sends — so streamed and
      // final stay disjoint BY CONSTRUCTION (not just via uuid exclusion), even
      // when tool-result lines trail the final block.
      const candidates = readClaudeMessagesFromRaw(raw).filter(
        (m) =>
          m.role === 'assistant' &&
          !m.isError &&
          m.text.trim() !== '' &&
          (Date.parse(m.timestamp) || 0) > sinceMs,
      )
      for (let i = 0; i < candidates.length - 1; i++) {
        if (!active || !isCurrent()) return
        const m = candidates[i]!
        if (sent.has(m.uuid)) continue
        sent.add(m.uuid)
        // One line per streamed block. A repeated uuid here = two streamers
        // double-posting (the bug this guards against); each uuid should
        // appear exactly once per turn.
        log.info('reply-stream posted', { sessionId, uuid: m.uuid, chars: m.text.length })
        try {
          await opts.tmuxStreamBlock!({ entry, text: m.text.trim() })
        } catch (err: any) {
          log.warn('reply-stream: post failed', { sessionId, err: err?.message ?? String(err) })
        }
      }
    }
    const loop = async (): Promise<void> => {
      while (active && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, STREAM_POLL_MS))
        if (!active) break
        inFlight = tick()
        try {
          await inFlight
        } catch {
          /* keep polling — a transient read/post error shouldn't kill the stream */
        }
      }
      if (streamers.get(sessionId) === self) streamers.delete(sessionId) // don't evict a successor
    }
    void loop()
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    try {
      if (
        req.method === 'GET' &&
        (url.pathname === '/api/status' ||
          url.pathname === '/api/internal/health' ||
          url.pathname === '/healthz')
      ) {
        // Three paths point at the same handler:
        //   - /api/status: the original endpoint, surfaced in the web UI
        //   - /api/internal/health: convention some operator probes
        //     reach for (we never had it before — adding for compat
        //     with external monitors that hard-code that path)
        //   - /healthz: k8s-style liveness probe naming
        sendJson(res, 200, {
          ok: true,
          mode: opts.mode,
          instanceId: opts.instanceId,
          uptimeSec: (Date.now() - startedAt) / 1000,
          pid: process.pid,
          bindHost: boundHost,
        })
        return
      }

      if (req.method === 'GET' && url.pathname === '/api/config') {
        const cfg = loadUserConfigFile()
        sendJson(res, 200, { path: userConfigPath(), config: maskConfigForView(cfg) })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/config') {
        const incoming = (await readJsonBody(req)) as Partial<UserConfigFile>
        const existing = loadUserConfigFile()
        // Merge: any field present in `incoming` overwrites; absent fields preserve
        // the existing value. This is how "leave secret blank to keep" works.
        const merged: UserConfigFile = { ...existing }
        for (const [k, v] of Object.entries(incoming)) {
          if (typeof v === 'string' && v.length > 0) {
            ;(merged as any)[k] = v
          }
        }
        writeUserConfigFile(merged)
        sendJson(res, 200, { path: userConfigPath(), saved: true })
        return
      }


      // ── All-machine claude session scan ─────────────────────
      // Always on — this is a personal dev-box tool, trusted network.
      // If you ever deploy clawx in a shared/multi-user environment,
      // re-introduce a bind-based gate here.

      if (req.method === 'GET' && url.pathname === '/api/claude-sessions/all') {
        const allBotEntries = opts.sessionStore.entries()
        // inBot = tracked by SessionStore (feishu bot / cli / tmux).
        const botUuids = new Set(allBotEntries.map((e) => e.claudeUuid))
        // Cross-reference schedule history so we can label sessions that were
        // spawned by a cron-engine `prompt` run.
        const scheduleByUuid = new Map<string, string>()
        for (const r of loadSchedules().history) {
          if (r.claudeUuid && !scheduleByUuid.has(r.claudeUuid)) {
            scheduleByUuid.set(r.claudeUuid, r.scheduleName)
          }
        }
        const all = scanAllClaudeSessions().map((m) => ({
          ...m,
          inBot: botUuids.has(m.uuid),
          scheduleName: scheduleByUuid.get(m.uuid),
        }))
        sendJson(res, 200, { sessions: all, root: claudeProjectsRoot() })
        return
      }

      // ── All-machine codex session scan ──────────────────────
      // Mirrors the claude scan above but reads ~/.codex/sessions.
      // Codex metadata is leaner (no bot/schedule/chat cross-ref), so
      // this just returns the raw scan + root.
      if (req.method === 'GET' && url.pathname === '/api/codex-sessions/all') {
        sendJson(res, 200, { sessions: scanAllCodexSessions(), root: codexSessionsRoot() })
        return
      }

      // ── Rooms (forge-room multi-agent teams) ────────────────
      // Read-only list, mirroring `clawx room ls`. Picks just the
      // fields the dashboard table renders — the full RoomState carries
      // bridge bookkeeping (jsonl offsets, ping watermarks) the UI
      // doesn't need.
      if (req.method === 'GET' && url.pathname === '/api/rooms') {
        const rooms = listRooms().map((r) => ({
          id: r.id,
          label: r.label,
          status: r.status,
          cwd: r.cwd,
          template: r.template,
          createdAt: r.createdAt,
          threadId: r.threadId,
        }))
        sendJson(res, 200, { rooms })
        return
      }

      const allMsgMatch = url.pathname.match(/^\/api\/claude-sessions\/([a-f0-9-]{36})\/messages$/i)
      if (req.method === 'GET' && allMsgMatch) {
        const uuid = allMsgMatch[1]!
        const result = readMessagesByUuidFromProjects(uuid)
        if (!result) {
          sendJson(res, 404, { error: 'session not found on this host' })
          return
        }
        sendJson(res, 200, { ...result, nowMs: Date.now() })
        return
      }

      // Generic agent transcript reader for tmux sessions. Codex uses
      // this because its transcripts live under ~/.codex/sessions, not
      // ~/.claude/projects.
      const agentMsgMatch = url.pathname.match(/^\/api\/agent-sessions\/(claude|codex)\/([^/]+)\/messages$/)
      if (req.method === 'GET' && agentMsgMatch) {
        const kind = agentMsgMatch[1] as AgentKind
        const id = decodeURIComponent(agentMsgMatch[2]!)
        const result = readAgentMessagesById(kind, id)
        if (!result) {
          sendJson(res, 404, { error: 'session not found on this host' })
          return
        }
        sendJson(res, 200, { ...result, nowMs: Date.now() })
        return
      }

      // POST /api/claude-sessions/:uuid/reply — inject a new user turn into
      // an existing claude session by spawning `claude --resume <uuid>
      // --print` in the session's original cwd. Symmetric with the
      // reply_to MCP tool used by /reply N. Hard 5-minute wall-clock cap.
      const allReplyMatch = url.pathname.match(/^\/api\/claude-sessions\/([a-f0-9-]{36})\/reply$/i)
      if (req.method === 'POST' && allReplyMatch) {
        const uuid = allReplyMatch[1]!
        const body = (await readJsonBody(req)) as { prompt?: unknown } | null
        const prompt = typeof body?.prompt === 'string' ? body.prompt : ''
        if (!prompt.trim()) {
          sendJson(res, 400, { ok: false, error: 'prompt is required' })
          return
        }
        if (prompt.length > 16 * 1024) {
          sendJson(res, 400, { ok: false, error: 'prompt too long (16 KiB max)' })
          return
        }
        const located = locateSession(uuid)
        if (!located) {
          sendJson(res, 404, { ok: false, error: 'session not found on this host' })
          return
        }
        const claudeCmd = process.env.CLAUDE_CMD?.trim() || 'claude'
        const cwd = located.cwd ?? opts.claudeCwd
        const HARD_TIMEOUT_MS = 300_000
        try {
          const t0 = Date.now()
          const response = await createClaudeHandle().run(prompt, {
            cmd: claudeCmd,
            cwd,
            sessionId: uuid,
            isNewSession: false,
            timeoutMs: HARD_TIMEOUT_MS,
            hardTimeoutMs: HARD_TIMEOUT_MS,
          })
          const durationMs = Date.now() - t0
          sendJson(res, 200, { ok: true, response, durationMs })
        } catch (err: any) {
          const errorMsg = err?.message ?? String(err)
          log.warn('web reply failed', { uuid, err: errorMsg })
          sendJson(res, 500, { ok: false, error: errorMsg })
        }
        return
      }

      // ── tmux sessions (Phase 1: web-only CRUD, no Lark yet) ─────

      // GET /api/tmux-sessions — list known tmux sessions.
      if (req.method === 'GET' && url.pathname === '/api/tmux-sessions') {
        sendJson(res, 200, { sessions: tmuxOrchestrator.list() })
        return
      }

      // GET /api/cwd-suggestions — tiered cwd picker source.
      //
      // Three layers, in display order:
      //   1. `favorite` — explicit `tmuxCwdFavorites` from
      //      ~/.config/clawx/config.json. Operator-curated, shown
      //      first. (Persists across daemon restarts; reload-free.)
      //   2. `scanned`  — immediate children of every dir in
      //      `tmuxCwdScanRoots` (default `[~/workspace]`).
      //      Useful for the common "目录下面有 N 个项目" case
      //      without needing to manually pin each one.
      //   3. `recent`   — tmux-store + scanAllClaudeSessions cwds the
      //      machine has actually used, sorted by last-modified.
      //
      // Same path appearing in multiple layers keeps the
      // higher-priority source. Capped at 100 rows total.
      if (req.method === 'GET' && url.pathname === '/api/cwd-suggestions') {
        const cfg = loadUserConfigFile()
        const home = os.homedir()
        const suggestions: Array<{
          cwd: string
          source: 'favorite' | 'scanned' | 'recent'
          lastUsedMs?: number
        }> = []
        const seen = new Set<string>()

        // 1. Favorites — preserve config order so the operator's intent
        // is visible. Expand `~/` for ergonomic config files.
        for (const raw of cfg.tmuxCwdFavorites ?? []) {
          const cwd = expandHomePath(raw)
          if (seen.has(cwd)) continue
          seen.add(cwd)
          suggestions.push({ cwd, source: 'favorite' })
        }

        // 2. Scanned — immediate children only (one level deep). User
        // configures `tmuxCwdScanRoots`; we default to ~/workspace.
        const scanRoots = (
          cfg.tmuxCwdScanRoots ?? [path.join(home, 'workspace')]
        ).map(expandHomePath)
        for (const root of scanRoots) {
          if (!fs.existsSync(root)) continue
          try {
            const names = fs.readdirSync(root, { withFileTypes: true })
            const dirs = names
              .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
              .map((d) => path.join(root, d.name))
              .sort()
            for (const d of dirs) {
              if (seen.has(d)) continue
              seen.add(d)
              suggestions.push({ cwd: d, source: 'scanned' })
            }
          } catch {
            /* unreadable scan root — skip */
          }
        }

        // 3. Recent — tmux store + every claude session jsonl on host.
        const recent = new Map<string, number>()
        for (const e of tmuxSessionStore.entries()) {
          const t = Date.parse(e.lastTurnAt ?? e.createdAt) || 0
          const prev = recent.get(e.cwd) ?? 0
          if (t > prev) recent.set(e.cwd, t)
        }
        for (const s of scanAllClaudeSessions()) {
          if (!s.cwd) continue
          const t = Date.parse(s.lastModified) || 0
          const prev = recent.get(s.cwd) ?? 0
          if (t > prev) recent.set(s.cwd, t)
        }
        const sortedRecent = Array.from(recent.entries()).sort(
          (a, b) => b[1] - a[1],
        )
        for (const [cwd, lastUsedMs] of sortedRecent) {
          if (seen.has(cwd)) continue
          seen.add(cwd)
          suggestions.push({ cwd, source: 'recent', lastUsedMs })
        }

        sendJson(res, 200, { suggestions: suggestions.slice(0, 100) })
        return
      }

      // POST /api/cwd-favorites — add a cwd to the favorites list.
      // Body: { cwd: string }. Idempotent (no-op if already favorited).
      if (req.method === 'POST' && url.pathname === '/api/cwd-favorites') {
        const body = (await readJsonBody(req)) as { cwd?: unknown } | null
        const cwd = typeof body?.cwd === 'string' ? body.cwd.trim() : ''
        if (!cwd) {
          sendJson(res, 400, { ok: false, error: 'cwd required' })
          return
        }
        try {
          const favorites = addCwdFavorite(cwd)
          sendJson(res, 200, { ok: true, favorites })
        } catch (err: any) {
          sendJson(res, 500, { ok: false, error: err?.message ?? String(err) })
        }
        return
      }

      // DELETE /api/cwd-favorites — remove a cwd from favorites.
      // Body: { cwd: string }.
      if (req.method === 'DELETE' && url.pathname === '/api/cwd-favorites') {
        const body = (await readJsonBody(req)) as { cwd?: unknown } | null
        const cwd = typeof body?.cwd === 'string' ? body.cwd.trim() : ''
        if (!cwd) {
          sendJson(res, 400, { ok: false, error: 'cwd required' })
          return
        }
        try {
          const favorites = removeCwdFavorite(cwd)
          sendJson(res, 200, { ok: true, favorites })
        } catch (err: any) {
          sendJson(res, 500, { ok: false, error: err?.message ?? String(err) })
        }
        return
      }

      // POST /api/tmux-sessions — create a new one (single uniform
      // endpoint used by bot's /new-tmux command, the web TmuxTab
      // "create" form, AND the `clawx tmux` CLI subcommand).
      //
      // Body: { sessionId?, cwd, label?, withThread? }
      // - sessionId: defaults to `cli-tmux-<8hex>` so callers don't
      //   need to coordinate ids
      // - cwd: required
      // - label: free-form display name
      // - withThread: defaults to TRUE when larkThread+chatId are
      //   configured (so all three entry points get a thread by
      //   default). Pass `false` for "web-only" sessions that don't
      //   need Lark visibility.
      if (req.method === 'POST' && url.pathname === '/api/tmux-sessions') {
        const body = (await readJsonBody(req)) as {
          sessionId?: unknown
          cwd?: unknown
          label?: unknown
          withThread?: unknown
          source?: unknown
          resumeUuid?: unknown
          group?: unknown
          agent?: unknown
        } | null
        const cwd = typeof body?.cwd === 'string' ? body.cwd.trim() : ''
        if (!cwd) {
          sendJson(res, 400, { ok: false, error: 'cwd required' })
          return
        }
        const sessionId =
          typeof body?.sessionId === 'string' && body.sessionId.trim()
            ? body.sessionId.trim()
            : `cli-tmux-${Math.random().toString(16).slice(2, 10)}`
        const label = typeof body?.label === 'string' ? body.label : undefined
        const resumeUuid =
          typeof body?.resumeUuid === 'string' && body.resumeUuid.trim()
            ? body.resumeUuid.trim()
            : undefined
        const agentKind = normalizeAgentKind(body?.agent)
        if (!agentKind) {
          sendJson(res, 400, { ok: false, error: 'agent must be claude or codex' })
          return
        }
        // Where the create call came from. Used in the seed text so
        // multiple sessions in the thread group are easier to tell
        // apart by origin. Whitelisted set; unknown values render as
        // "未知".
        const creatorRaw = typeof body?.source === 'string' ? body.source : ''
        const creator: SendSource | 'unknown' =
          creatorRaw === 'web' || creatorRaw === 'cli' || creatorRaw === 'lark'
            ? creatorRaw
            : 'unknown'
        // Topic group resolution: `--group <name>` picks a named group
        // from config.tmuxThreadChats; without it, the default
        // (tmuxThreadChatId / env). An unknown group name is rejected so
        // a typo never silently lands in the wrong (default) group.
        const group = typeof body?.group === 'string' ? body.group.trim() : ''
        let threadChatId: string
        if (group) {
          const named = opts.tmuxThreadChats?.[group]?.trim()
          if (!named) {
            const known = Object.keys(opts.tmuxThreadChats ?? {})
            sendJson(res, 400, {
              ok: false,
              error:
                `unknown --group "${group}" — 配置 tmuxThreadChats 里没有这个名字` +
                (known.length
                  ? `（已知: ${known.join(', ')}）`
                  : '（当前未配置任何命名群）'),
            })
            return
          }
          threadChatId = named
        } else {
          threadChatId =
            opts.tmuxThreadChatId?.trim() ||
            process.env.CLAWX_TMUX_THREAD_CHAT_ID?.trim() ||
            ''
        }
        const canThread = !!opts.larkThread && !!threadChatId
        const withThread =
          typeof body?.withThread === 'boolean' ? body.withThread : canThread
        try {
          let entry = await tmuxOrchestrator.create({
            sessionId,
            cwd,
            label,
            resumeUuid,
            agentKind,
          })
          // create() may have re-bound this (resumed) session to a prior
          // session's Lark thread — when the resumed claude uuid already
          // owned one. In that case DON'T mint a new thread: announce the
          // resume in the existing thread so the conversation continues
          // in place (turn-done fanout already routes by entry.threadId).
          const reusedThread = !!(entry.threadId && entry.rootMessageId)
          if (reusedThread) {
            if (opts.larkThread) {
              try {
                await opts.larkThread.postInThread({
                  rootMessageId: entry.rootMessageId!,
                  text:
                    `🔄 会话已恢复（模型/进程已刷新，上下文保留）\n` +
                    `sid: ${entry.sessionId}\n` +
                    `继续在本话题对话即可。`,
                })
              } catch (err: any) {
                log.warn('tmux resume: thread re-announce failed', {
                  sessionId: entry.sessionId,
                  err: err?.message ?? String(err),
                })
              }
            }
          } else if (withThread && canThread) {
            try {
              const t = await opts.larkThread!.createThread({
                chatId: threadChatId,
                seedText: formatSeedText({
                  cwd,
                  sessionId: entry.sessionId,
                  tmuxName: entry.tmuxName,
                  claudeUuid: entry.claudeUuid,
                  agentKind: entry.agentKind,
                  agentSessionId: entry.agentSessionId,
                  label,
                  creator,
                  resumed: !!resumeUuid,
                  mentionOpenId:
                    typeof opts.userOpenId === 'function'
                      ? opts.userOpenId()
                      : opts.userOpenId,
                }),
              })
              entry = tmuxSessionStore.patch(entry.sessionId, {
                threadId: t.threadId,
                chatId: threadChatId,
                rootMessageId: t.rootMessageId,
              })
            } catch (err: any) {
              // Thread failure shouldn't roll back the tmux session —
              // the user can still attach + chat via web/terminal.
              log.warn('tmux create: thread setup failed', {
                sessionId: entry.sessionId,
                err: err?.message ?? String(err),
              })
            }
          }
          sendJson(res, 200, { ok: true, entry })
        } catch (err: any) {
          sendJson(res, 500, { ok: false, error: err?.message ?? String(err) })
        }
        return
      }

      // POST /api/tmux-sessions/:sid/send — type text + Enter into the
      // session's pane. Used by the web composer when the chat is bound
      // to a tmux session. Returns immediately; turn-done flows back
      // via the Stop-hook → /api/internal/turn-done loop.
      //
      // If the session has a Lark thread, we ALSO post a user echo
      // message into the thread BEFORE typing into the pane, so the
      // PreToolUse-driven ⏳ reaction has a target message_id to attach
      // to. The Lark inbound path (ws-main.ts) uses the user's own
      // webhook message_id and sets currentTurnUserMessageId there.
      const tmuxSendMatch = url.pathname.match(/^\/api\/tmux-sessions\/([^/]+)\/send$/)
      if (req.method === 'POST' && tmuxSendMatch) {
        const sid = decodeURIComponent(tmuxSendMatch[1]!)
        const body = (await readJsonBody(req)) as {
          text?: unknown
          source?: unknown
        } | null
        const text = typeof body?.text === 'string' ? body.text : ''
        const source: SendSource =
          body?.source === 'lark' || body?.source === 'cli'
            ? body.source
            : 'web' // default for plain POST callers
        if (!text.trim()) {
          sendJson(res, 400, { ok: false, error: 'text required' })
          return
        }
        try {
          const entry = tmuxSessionStore.get(sid)
          // Post user echo to Lark thread as an interactive card
          // (web/cli sources only — lark source already has the
          // original user message visible in the thread).
          if (
            entry &&
            entry.threadId &&
            entry.rootMessageId &&
            opts.larkThread &&
            source !== 'lark'
          ) {
            try {
              const echoRes = await opts.larkThread.postCardInThread({
                rootMessageId: entry.rootMessageId,
                card: buildForwardCard({ source, text }),
              })
              tmuxSessionStore.patch(sid, {
                currentTurnUserMessageId: echoRes.messageId,
                currentTurnReactionId: undefined,
              })
            } catch (err: any) {
              log.warn('tmux send: user echo post failed', {
                sessionId: sid,
                err: err?.message ?? String(err),
              })
            }
          }
          await tmuxOrchestrator.send(sid, text, source)
          sendJson(res, 200, { ok: true })
        } catch (err: any) {
          sendJson(res, 500, { ok: false, error: err?.message ?? String(err) })
        }
        return
      }

      // GET /api/tmux-sessions/states — coarse live status per session for
      // the dashboard cards. One pane capture + classify per session; a dead
      // session's capture rejects → marked offline. Polled slower than the
      // list (the capture is the costly part), so keep it its own endpoint.
      if (req.method === 'GET' && url.pathname === '/api/tmux-sessions/states') {
        const entries = tmuxSessionStore.entries()
        const states = await Promise.all(
          entries.map(async (e) => {
            const working = !!e.currentTurnUserMessageId
            let alive = false
            let repl = 'unknown'
            try {
              repl = classifyReplState(await tmuxOrchestrator.capture(e.sessionId, 80))
              alive = true
            } catch {
              alive = false
              repl = 'dead'
            }
            // Collapse to one badge value the card renders directly.
            const status = !alive
              ? 'offline'
              : repl === 'rate-limit' || repl === 'dialog'
                ? 'stuck'
                : working || repl === 'generating'
                  ? 'working'
                  : 'idle'
            return { sessionId: e.sessionId, status, repl, alive, working }
          }),
        )
        sendJson(res, 200, { states })
        return
      }

      // GET /api/tmux-sessions/:sid/capture — return current pane text
      // (capture-pane + scrollback). For UI debug / hydration only —
      // turn-by-turn rendering should go through the jsonl path.
      const tmuxCapMatch = url.pathname.match(/^\/api\/tmux-sessions\/([^/]+)\/capture$/)
      if (req.method === 'GET' && tmuxCapMatch) {
        const sid = decodeURIComponent(tmuxCapMatch[1]!)
        try {
          const text = await tmuxOrchestrator.capture(sid)
          sendJson(res, 200, { ok: true, text })
        } catch (err: any) {
          sendJson(res, 404, { ok: false, error: err?.message ?? String(err) })
        }
        return
      }

      // DELETE /api/tmux-sessions/:sid — kill + drop mapping, then post a
      // "cleaned up" notice into the session's Lark thread so the operator
      // can tell at a glance which threads are done vs still live.
      const tmuxDelMatch = url.pathname.match(/^\/api\/tmux-sessions\/([^/]+)$/)
      if (req.method === 'DELETE' && tmuxDelMatch) {
        const sid = decodeURIComponent(tmuxDelMatch[1]!)
        // Snapshot the thread info BEFORE kill() drops the store record.
        const doomed = tmuxSessionStore.get(sid)
        // Killed mid-turn: stop the streamer or its poll loop would outlive
        // the session (turn-done never fires for a killed session).
        await stopReplyStreamer(sid)
        try {
          await tmuxOrchestrator.kill(sid)
          if (doomed?.threadId && doomed.rootMessageId && opts.larkThread) {
            const label = doomed.label?.trim()
            try {
              await opts.larkThread.postInThread({
                rootMessageId: doomed.rootMessageId,
                text:
                  `🧹 会话已清理${label ? `（${label}）` : ''}\n` +
                  `tmux 会话已结束、记录已删除，本话题不再接收新消息。`,
              })
            } catch (err: any) {
              log.warn('tmux delete: cleanup notice failed', {
                sessionId: sid,
                err: err?.message ?? String(err),
              })
            }
          }
          sendJson(res, 200, { ok: true })
        } catch (err: any) {
          sendJson(res, 500, { ok: false, error: err?.message ?? String(err) })
        }
        return
      }

      async function handleAgentTurnStart(args: {
        agentKind: AgentKind
        agentSessionId: string
        prompt: string
        transcriptPath?: string
      }): Promise<{ status: number; body: unknown }> {
        const trimmed = args.prompt.trim()
        let entry = tmuxSessionStore.getByAgentSession(args.agentKind, args.agentSessionId)
        if (!entry) {
          if (args.agentKind === 'codex') {
            const cwd = locateCodexSession(args.agentSessionId)?.cwd
            const pending = tmuxSessionStore
              .entries()
              .filter((e) => e.agentKind === 'codex' && !e.agentSessionId)
              .find((e) => !cwd || e.cwd === cwd)
            if (pending) {
              entry = tmuxSessionStore.patch(pending.sessionId, {
                agentSessionId: args.agentSessionId,
                transcriptPath: args.transcriptPath,
                agentSessionPending: false,
              })
            }
          }
          if (!entry) return { status: 200, body: { ok: true, matched: false } }
        } else if (args.transcriptPath && entry.transcriptPath !== args.transcriptPath) {
          entry = tmuxSessionStore.patch(entry.sessionId, { transcriptPath: args.transcriptPath })
        }
        if (!trimmed || trimmed.startsWith('<task-notification>') || /<task-id>/i.test(trimmed)) {
          return { status: 200, body: { ok: true, skipped: 'synthetic' } }
        }
        tmuxOrchestrator.confirmTurnStarted(entry.sessionId)
        const knownSource = tmuxOrchestrator.peekSendSource(entry.sessionId, args.prompt)
        if (!knownSource && entry.threadId && entry.rootMessageId && opts.larkThread) {
          try {
            const echo = await opts.larkThread.postCardInThread({
              rootMessageId: entry.rootMessageId,
              card: buildForwardCard({ source: 'terminal', text: args.prompt }),
            })
            entry = tmuxSessionStore.patch(entry.sessionId, {
              currentTurnUserMessageId: echo.messageId,
              currentTurnReactionId: undefined,
            })
          } catch (err: any) {
            log.warn('tmux turn-start: echo post failed', { sessionId: entry.sessionId, err: err?.message ?? String(err) })
          }
        }
        if (entry.currentTurnUserMessageId && !entry.currentTurnReactionId && opts.larkThread) {
          const emoji = opts.tmuxProgressEmoji?.trim() || 'THINKING'
          try {
            const r = await opts.larkThread.addReaction({ messageId: entry.currentTurnUserMessageId, emojiType: emoji })
            tmuxSessionStore.patch(entry.sessionId, { currentTurnReactionId: r.reactionId })
          } catch (err: any) {
            log.warn('tmux turn-start: reaction add failed', { sessionId: entry.sessionId, emoji, err: err?.message ?? String(err) })
          }
        }
        // Begin tailing this turn's transcript so settled intermediate blocks
        // stream to the thread as they land (no-op unless CLAWX_STREAM_REPLIES
        // is on). Same boundary as turn-done so we only consider THIS turn.
        const streamSince =
          (entry.lastTurnAt ? Date.parse(entry.lastTurnAt) : 0) || Date.parse(entry.createdAt) || 0
        startReplyStreamer(entry, streamSince)
        return { status: 200, body: { ok: true } }
      }

      function handleAgentTurnDone(args: {
        agentKind: AgentKind
        agentSessionId: string
        transcriptPath?: string
        recovered?: boolean
      }): Promise<{ status: number; body: unknown }> {
        // Per-session lock: serialize so the Stop hook and the watchdog
        // recover can't both deliver the same turn (see serializeTurnDone).
        return serializeTurnDone(`${args.agentKind}:${args.agentSessionId}`, () =>
          handleAgentTurnDoneInner(args),
        )
      }

      async function handleAgentTurnDoneInner(args: {
        agentKind: AgentKind
        agentSessionId: string
        transcriptPath?: string
        recovered?: boolean
      }): Promise<{ status: number; body: unknown }> {
        let entry = tmuxSessionStore.getByAgentSession(args.agentKind, args.agentSessionId)
        if (!entry && args.agentKind === 'codex') {
          const pending = tmuxSessionStore
            .entries()
            .filter((e) => e.agentKind === 'codex' && !e.agentSessionId)
            .find((e) => !args.transcriptPath || e.transcriptPath === args.transcriptPath)
          if (pending) {
            entry = tmuxSessionStore.patch(pending.sessionId, {
              agentSessionId: args.agentSessionId,
              transcriptPath: args.transcriptPath,
              agentSessionPending: false,
            })
          }
        }
        if (!entry) return { status: 200, body: { ok: true, matched: false } }
        // The turn is ending — stop tailing it and take the set of blocks the
        // streamer already sent, so the gather below excludes them (no block
        // is ever delivered twice, even in odd transcript orderings).
        const streamedUuids = await stopReplyStreamer(entry.sessionId)
        if (args.transcriptPath && entry.transcriptPath !== args.transcriptPath) {
          entry = tmuxSessionStore.patch(entry.sessionId, { transcriptPath: args.transcriptPath })
        }
        const sinceMs = (entry.lastTurnAt ? Date.parse(entry.lastTurnAt) : 0) || Date.parse(entry.createdAt) || 0
        const located = locateAgentTranscript(args.agentKind, args.agentSessionId, args.transcriptPath || entry.transcriptPath)
        let assistantText: string | null = null
        let userText: string | null = null
        let messageCount = 0
        let turnEndedInError = false
        if (located?.jsonlPath && fs.existsSync(located.jsonlPath)) {
          try {
            for (let attempt = 0; attempt < 16; attempt++) {
              let raw = ''
              try { raw = fs.readFileSync(located.jsonlPath, 'utf8') } catch { break }
              let codexCompleted: Set<string> | null = null
              let messages: UiMessage[]
              if (args.agentKind === 'codex') {
                const parsed = readCodexMessagesFromRaw(raw)
                messages = parsed.messages
                codexCompleted = parsed.completedTurnIds
              } else {
                messages = readClaudeMessagesFromRaw(raw)
              }
              messageCount = messages.length
              const turnAssistant: UiMessage[] = []
              const turnUser: string[] = []
              for (const m of messages) {
                const ts = Date.parse(m.timestamp) || 0
                if (ts <= sinceMs) continue
                if (m.role === 'assistant' && m.text.trim()) {
                  // Skip blocks already streamed mid-turn so they aren't
                  // re-sent as part of the final fanout.
                  if (!streamedUuids.has(m.uuid)) turnAssistant.push(m)
                } else if (m.role === 'user' && m.text.trim()) turnUser.push(m.text)
              }
              const last = turnAssistant[turnAssistant.length - 1]
              const lastIsError = !!last?.isError
              turnEndedInError = lastIsError
              assistantText = last ? (lastIsError ? `🚨 ${args.agentKind} API 报错 (本轮终止):\n\n${last.text.trim()}` : last.text.trim()) : null
              userText = turnUser.length > 0 ? turnUser[0]! : null
              // Codex: a turn is complete only once the transcript has a
              // task_complete event (codexCompleted), not merely a reply
              // block — this waits out the ~1s gap between the final
              // message and its task_complete marker, so we don't fan out
              // (or stop retrying) before the turn truly ended.
              const turnComplete = last !== undefined && (lastIsError ||
                (args.agentKind === 'codex'
                  ? (codexCompleted?.size ?? 0) > 0
                  : last.stopReason === 'end_turn' || last.stopReason === 'stop_sequence' || last.stopReason === 'max_tokens'))
              if (turnComplete) break
              // Nothing new past the boundary — no assistant reply to wait on
              // a task_complete for, and no pending user turn to hold for.
              // Happens when a duplicate turn-done lands after the boundary
              // already advanced (the per-session lock serializes these, so
              // this is the deduped no-op call). Looping can't surface
              // anything; break now instead of polling the full ~7.5s.
              if (last === undefined && turnUser.length === 0) break
              if (attempt === 15) break
              await new Promise((r) => setTimeout(r, 500))
            }
          } catch (err: any) {
            log.warn('turn-done: jsonl parse failed', { transcriptPath: located.jsonlPath, agentKind: args.agentKind, err: err?.message ?? String(err) })
          }
        }
        const synthetic = !turnEndedInError && isSyntheticTurn(userText, assistantText)
        if (!assistantText?.trim() && !!userText?.trim() && !synthetic && !turnEndedInError && !args.recovered) {
          return { status: 200, body: { ok: true, held: true } }
        }
        if (entry.currentTurnReactionId && entry.currentTurnUserMessageId && opts.larkThread) {
          try { await opts.larkThread.removeReaction({ messageId: entry.currentTurnUserMessageId, reactionId: entry.currentTurnReactionId }) }
          catch (err: any) { log.warn('tmux turn-done: reaction remove failed', { sessionId: entry.sessionId, err: err?.message ?? String(err) }) }
        }
        const updated = tmuxSessionStore.patch(entry.sessionId, {
          lastTurnAt: new Date().toISOString(),
          currentTurnUserMessageId: undefined,
          currentTurnReactionId: undefined,
          agentSessionId: args.agentSessionId,
          transcriptPath: located?.jsonlPath ?? args.transcriptPath ?? entry.transcriptPath,
          agentSessionPending: false,
        })
        const userSource: SendSource = userText ? tmuxOrchestrator.identifySendSource(entry.sessionId, userText) ?? 'terminal' : 'terminal'
        log.info('tmux turn done', { sessionId: updated.sessionId, agentKind: args.agentKind, agentSessionId: args.agentSessionId, messageCount, assistantChars: assistantText?.length ?? 0, userSource, synthetic })
        if (opts.tmuxFanout && !synthetic) {
          await opts.tmuxFanout({ entry: updated, assistantText, userText, userSource, messageCount })
        }
        return { status: 200, body: { ok: true, matched: true, sessionId: updated.sessionId, assistantChars: assistantText?.length ?? 0 } }
      }

      // POST /api/internal/ask-question — called by the tmux-hook shim
      // when claude tries to invoke AskUserQuestion in this tmux mode.
      if (req.method === 'POST' && url.pathname === '/api/internal/ask-question') {
        const body = (await readJsonBody(req)) as { claude_uuid?: unknown; tool_input?: unknown } | null
        const claudeUuid = typeof body?.claude_uuid === 'string' ? body.claude_uuid : ''
        if (!claudeUuid) { sendJson(res, 400, { ok: false, error: 'claude_uuid required' }); return }
        const entry = tmuxSessionStore.getByClaudeUuid(claudeUuid)
        if (!entry) { sendJson(res, 200, { ok: true, matched: false }); return }
        let questions: AskQuestionItem[] = []
        const rawTi = body?.tool_input
        if (rawTi && typeof rawTi === 'object' && 'questions' in rawTi) {
          const qs = (rawTi as { questions?: unknown }).questions
          if (Array.isArray(qs)) questions = qs.filter((q): q is AskQuestionItem => !!q && typeof q === 'object')
        }
        if (!entry.threadId || !entry.rootMessageId || !opts.larkThread) { sendJson(res, 200, { ok: true, skipped: 'no-thread' }); return }
        try { await opts.larkThread.postCardInThread({ rootMessageId: entry.rootMessageId, card: buildAskQuestionCard({ questions }) }) }
        catch (err: any) { log.warn('tmux ask-question: card post failed', { sessionId: entry.sessionId, err: err?.message ?? String(err) }) }
        sendJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/internal/turn-start') {
        const body = (await readJsonBody(req)) as { claude_uuid?: unknown; prompt?: unknown } | null
        const claudeUuid = typeof body?.claude_uuid === 'string' ? body.claude_uuid : ''
        const prompt = typeof body?.prompt === 'string' ? body.prompt : ''
        if (!claudeUuid) { sendJson(res, 400, { ok: false, error: 'claude_uuid required' }); return }
        const r = await handleAgentTurnStart({ agentKind: 'claude', agentSessionId: claudeUuid, prompt })
        sendJson(res, r.status, r.body)
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/internal/agent-turn-start') {
        const body = (await readJsonBody(req)) as { agentKind?: unknown; agentSessionId?: unknown; transcriptPath?: unknown; prompt?: unknown } | null
        const agentKind = normalizeAgentKind(body?.agentKind)
        const agentSessionId = typeof body?.agentSessionId === 'string' ? body.agentSessionId : ''
        const transcriptPath = typeof body?.transcriptPath === 'string' ? body.transcriptPath : undefined
        const prompt = typeof body?.prompt === 'string' ? body.prompt : ''
        if (!agentKind) { sendJson(res, 400, { ok: false, error: 'agentKind must be claude or codex' }); return }
        if (!agentSessionId) { sendJson(res, 400, { ok: false, error: 'agentSessionId required' }); return }
        const r = await handleAgentTurnStart({ agentKind, agentSessionId, transcriptPath, prompt })
        sendJson(res, r.status, r.body)
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/internal/turn-done') {
        const body = (await readJsonBody(req)) as { claude_uuid?: unknown; transcript_path?: unknown; recovered?: unknown } | null
        const claudeUuid = typeof body?.claude_uuid === 'string' ? body.claude_uuid : ''
        const transcriptPath = typeof body?.transcript_path === 'string' ? body.transcript_path : ''
        if (!claudeUuid) { sendJson(res, 400, { ok: false, error: 'claude_uuid required' }); return }
        const r = await handleAgentTurnDone({ agentKind: 'claude', agentSessionId: claudeUuid, transcriptPath, recovered: body?.recovered === true })
        sendJson(res, r.status, r.body)
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/internal/agent-turn-done') {
        const body = (await readJsonBody(req)) as { agentKind?: unknown; agentSessionId?: unknown; transcriptPath?: unknown; recovered?: unknown } | null
        const agentKind = normalizeAgentKind(body?.agentKind)
        const agentSessionId = typeof body?.agentSessionId === 'string' ? body.agentSessionId : ''
        const transcriptPath = typeof body?.transcriptPath === 'string' ? body.transcriptPath : undefined
        if (!agentKind) { sendJson(res, 400, { ok: false, error: 'agentKind must be claude or codex' }); return }
        if (!agentSessionId) { sendJson(res, 400, { ok: false, error: 'agentSessionId required' }); return }
        const r = await handleAgentTurnDone({ agentKind, agentSessionId, transcriptPath, recovered: body?.recovered === true })
        sendJson(res, r.status, r.body)
        return
      }

      // ── Schedules CRUD + run-now ─────────────────────────────

      if (req.method === 'GET' && url.pathname === '/api/schedules') {
        const state = loadSchedules()
        const enriched = state.schedules.map((s) => ({
          ...s,
          // Compute next 3 fire times for the UI to surface "next run".
          // Failing cron parses (shouldn't happen post-validation but be safe)
          // produce an empty array.
          nextRuns: nextFireTimes(
            { cron: s.cron, fireAt: s.fireAt, timezone: s.timezone },
            new Date(),
            3,
          ).map((d) => d.toISOString()),
        }))
        sendJson(res, 200, { schedules: enriched, history: state.history.slice(0, 20) })
        return
      }

      if (req.method === 'POST' && url.pathname === '/api/schedules') {
        const body = (await readJsonBody(req)) as Partial<CreateScheduleInput>
        const knownTmuxIds = new Set(tmuxSessionStore.entries().map((e) => e.sessionId))
        const validation = validateScheduleInput(body, knownTmuxIds)
        if (validation) {
          sendJson(res, 400, { error: validation })
          return
        }
        const created = createSchedule(body as CreateScheduleInput)
        sendJson(res, 200, { schedule: created })
        return
      }

      const scheduleByIdMatch = url.pathname.match(/^\/api\/schedules\/([a-f0-9-]{36})$/i)
      if (scheduleByIdMatch) {
        const id = scheduleByIdMatch[1]!
        if (req.method === 'PATCH') {
          const body = (await readJsonBody(req)) as UpdateScheduleInput
          // Validate tmuxSessionId on patch — it can be cleared (empty
          // string / null) to detach from a tmux session, or set to a
          // new live session.
          if ('tmuxSessionId' in body) {
            const raw = body.tmuxSessionId
            const sid = typeof raw === 'string' ? raw.trim() : ''
            if (sid) {
              const known = new Set(tmuxSessionStore.entries().map((e) => e.sessionId))
              if (!known.has(sid)) {
                sendJson(res, 400, {
                  error: `tmuxSessionId "${sid}" is not a live clawx tmux session`,
                })
                return
              }
            }
          }
          // For partial updates: only validate when trigger fields are
          // touched. Toggling enabled or renaming shouldn't require
          // re-validating an existing-good cron / fireAt.
          if ('cron' in body || 'fireAt' in body || 'timezone' in body) {
            // We need the merged shape to validate (e.g. patch sets cron
            // but the schedule had fireAt — must clear fireAt to make
            // sense). We pull the current state, apply the patch
            // shallowly, and validate the resulting trigger triple.
            const state = loadSchedules()
            const current = state.schedules.find((s) => s.id === id)
            if (!current) {
              sendJson(res, 404, { error: 'schedule not found' })
              return
            }
            const merged = {
              cron: 'cron' in body ? body.cron ?? undefined : current.cron,
              fireAt: 'fireAt' in body ? body.fireAt ?? undefined : current.fireAt,
              timezone: 'timezone' in body ? body.timezone ?? undefined : current.timezone,
            }
            const err = validateTrigger(merged)
            if (err) {
              sendJson(res, 400, { error: err })
              return
            }
          }
          const updated = updateSchedule(id, body)
          if (!updated) {
            sendJson(res, 404, { error: 'schedule not found' })
            return
          }
          sendJson(res, 200, { schedule: updated })
          return
        }
        if (req.method === 'DELETE') {
          const ok = deleteSchedule(id)
          sendJson(res, ok ? 200 : 404, { ok })
          return
        }
      }

      const runNowMatch = url.pathname.match(/^\/api\/schedules\/([a-f0-9-]{36})\/run-now$/i)
      if (req.method === 'POST' && runNowMatch) {
        const id = runNowMatch[1]!
        if (!opts.cronEngine) {
          sendJson(res, 503, { error: 'cron engine not running' })
          return
        }
        try {
          await opts.cronEngine.runNow(id)
          sendJson(res, 200, { ok: true })
        } catch (err: any) {
          sendJson(res, 500, { error: err?.message ?? String(err) })
        }
        return
      }

      // POST /api/cron/preview — used by the form to show "next 3 fire times"
      // as the user edits trigger fields. Stateless, no persistence.
      // Accepts either { cron, timezone? } or { fireAt }.
      if (req.method === 'POST' && url.pathname === '/api/cron/preview') {
        const body = (await readJsonBody(req)) as {
          cron?: string
          fireAt?: string
          timezone?: string
        }
        const trigger = {
          cron: typeof body?.cron === 'string' ? body.cron.trim() : undefined,
          fireAt: typeof body?.fireAt === 'string' ? body.fireAt.trim() : undefined,
          timezone: typeof body?.timezone === 'string' ? body.timezone.trim() : undefined,
        }
        const err = validateTrigger(trigger)
        if (err) {
          sendJson(res, 400, { error: err, valid: false })
          return
        }
        const nextRuns = nextFireTimes(trigger, new Date(), 3).map((d) => d.toISOString())
        sendJson(res, 200, { valid: true, nextRuns })
        return
      }

      // API namespace that didn't match anything → 404 JSON (don't
      // silently fall through to the SPA index.html, or fetch() callers
      // get HTML back on typo'd endpoints).
      if (url.pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: 'not found' })
        return
      }

      // Static asset serve + SPA fallback:
      //   1. Try the exact path under dist/web-assets/
      //   2. Fall through to index.html (SPA entry)
      //   3. If index.html itself is missing, return a helpful error page
      if (req.method === 'GET' || req.method === 'HEAD') {
        const target = safeResolveAsset(url.pathname, ASSETS_ROOT)
        if (target && serveStatic(res, target)) return
        const fallback = path.join(ASSETS_ROOT, 'index.html')
        if (serveStatic(res, fallback)) return
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(HTML_FALLBACK_404)
        return
      }

      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('method not allowed')
    } catch (err: any) {
      sendJson(res, 500, { error: err?.message ?? String(err) })
    }
  })

  const host = opts.host ?? '0.0.0.0'
  server.listen(opts.port, host, () => {
    // When bound to 0.0.0.0 the printed URL uses localhost for clickability,
    // but the server is actually reachable at every local interface.
    const display = host === '0.0.0.0' ? 'localhost' : host
    log.info('web ui ready', {
      url: `http://${display}:${opts.port}`,
      bind: `${host}:${opts.port}`,
    })
  })

  return server
}
