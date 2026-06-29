import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { log } from './logger.js'
import type { AgentKind } from './agent-backend.js'
import { waitForNewestCodexSessionForCwd } from './codex-sessions.js'
import { createTmuxMgr, type TmuxMgr } from './tmux-mgr.js'
import {
  TmuxSessionStore,
  type TmuxSessionEntry,
} from './tmux-session-store.js'
import { classifyReplState } from './repl-watchdog.js'

/**
 * Coordinates `tmux` and the session-store so the rest of the codebase
 * doesn't have to think about uuid allocation, name slugification, or
 * cleanup ordering.
 *
 * Lifecycle of one tmux-mode session:
 *   create()  → allocate uuid → tmux new-session running `claude
 *               --session-id <uuid> --permission-mode bypassPermissions`
 *               → record in store
 *   send()    → tmux send-keys (callers should serialize per-sid)
 *   kill()    → tmux kill-session + drop from store
 *
 * The claude REPL inside the tmux pane is long-lived; we DON'T tear it
 * down on clawx restart. tmux is the source of truth — on restart we
 * just re-read the store and trust that the session_name still exists.
 */

const TMUX_NAME_PREFIX = 'clawx-'

export interface CreateOptions {
  /** Stable identifier (chat:oc_xxx, web-conv id, etc.). Used as the
   * primary key in TmuxSessionStore. */
  sessionId: string
  /** cwd the claude REPL starts in. */
  cwd: string
  /** Optional human-readable label for UI rendering. */
  label?: string
  /** Optional Lark open_id of the user driving this session; used by
   * the Phase 1.5 fanout layer to DM the turn-done reply back. */
  userOpenId?: string
  /** If set, the new pane runs `claude --resume <uuid>` instead of
   * starting a fresh session. The recorded `claudeUuid` is this value
   * (so Stop-hook turn-done routing keeps working) and the jsonl on
   * disk continues to be appended. Used by `clawx tmux --resume`
   * to recover from an accidentally killed pane while keeping the
   * prior conversation context. */
  resumeUuid?: string
  /** Agent REPL to run. Defaults to Claude for backwards compatibility. */
  agentKind?: AgentKind
}

export interface TmuxOrchestratorDeps {
  store: TmuxSessionStore
  mgr?: TmuxMgr
  /** Claude binary to spawn inside the REPL pane. Defaults to `claude`
   * (PATH lookup). */
  claudeCmd?: string
  /** Codex binary to spawn inside the REPL pane. Defaults to `codex`. */
  codexCmd?: string
  /** Invoked when a sent message produces no turn-start within the
   * confirmation window even after one auto-retry — i.e. the REPL
   * silently swallowed the input (busy, or stuck on a huge context).
   * Lets the caller warn the user (e.g. post into the Lark thread). */
  onDeliveryUnconfirmed?: (info: {
    sessionId: string
    text: string
    source: SendSource
  }) => void
  /** Per-attempt wait for a turn-start before retrying / giving up.
   * Two attempts total (one retry). Defaults to 5000ms. */
  deliveryConfirmMs?: number
}

/** Where a user message came from. `'lark'` means the user typed in
 * the Lark thread directly (so the fanout shouldn't echo it back —
 * it's already visible there). Other sources need echoing. */
export type SendSource = 'web' | 'lark' | 'cli' | 'terminal'

export interface TmuxOrchestrator {
  create(opts: CreateOptions): Promise<TmuxSessionEntry>
  /** `source` is recorded into a per-sid ring buffer so the turn-done
   * handler can later figure out where the user's text came from
   * (and echo it back to the Lark thread with a proper tag). */
  send(sessionId: string, text: string, source: SendSource): Promise<void>
  /** Send the Escape key to the session's pane — interrupts the current
   * generation / cancels a pending prompt. Routed from a bare "esc"
   * message so the user can abort a runaway turn from Lark. */
  interrupt(sessionId: string): Promise<void>
  capture(sessionId: string, lines?: number): Promise<string>
  /** Coarse REPL state (generating / idle / dialog / rate-limit / unknown)
   * from a pane capture. Used to tell whether a freshly-sent message was
   * QUEUED (REPL busy generating) vs taken immediately. '' on failure. */
  peekReplState(sessionId: string): Promise<string>
  kill(sessionId: string): Promise<void>
  get(sessionId: string): TmuxSessionEntry | undefined
  list(): TmuxSessionEntry[]
  /** Look up the source of a user message we previously sent via tmux.
   * Returns null if the text isn't in the recent buffer (likely the
   * user typed it directly in their terminal attach). CONSUMES the
   * matching entry so a duplicate text doesn't re-match. */
  identifySendSource(sessionId: string, text: string): SendSource | null
  /** Same as identifySendSource but DOES NOT consume the buffer entry.
   * Used by the UserPromptSubmit-driven turn-start handler to dedupe
   * "should we post a user-echo to Lark?" without stealing the entry
   * that turn-done needs later. */
  peekSendSource(sessionId: string, text: string): SendSource | null
  /** Refresh the per-session `status-left` so the tmux bottom bar shows
   * the human-readable label. Called by `create()` automatically; also
   * called at daemon startup to backfill panes that existed before this
   * feature shipped. No-op when the session has no label or tmux can't
   * find the pane (e.g. session was killed externally). */
  applyDisplayLabel(sessionId: string): Promise<void>
  /** Called by the turn-start handler when claude begins processing a
   * real (non-synthetic) prompt. Confirms the most recent send for this
   * session actually landed, cancelling the delivery watchdog so it
   * won't retry / warn. No-op when nothing is pending. */
  confirmTurnStarted(sessionId: string): void
}

/**
 * Pull the proxy + claude-relevant env from the daemon's own process.
 *
 * Why: the tmux server is often started by the user's interactive
 * shell, which on this host carries the a corporate proxy
 * (`the corporate proxy host`). New tmux sessions inherit
 * that env. We MUST override the proxy keys so claude REPL goes
 * through mihomo (proxy-env.ts has already normalized the daemon's
 * own process.env to mihomo at startup).
 *
 * We also explicitly OVERRIDE both lowercase and uppercase forms —
 * tmux's `-e KEY=VAL` doesn't unset; whatever we don't set stays as
 * whatever the server inherited. If the daemon's env doesn't have a
 * key (e.g. when proxy injection is disabled), we still emit empty
 * overrides to neutralize the leak.
 */
function collectClaudeRuntimeEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  // Proxy vars: always present in the daemon after proxy-env.ts runs.
  // The empty-string fallback explicitly NEUTRALIZES anything the
  // tmux server had inherited from the corp-proxy interactive shell —
  // worse to leak than to drop.
  for (const key of [
    'http_proxy',
    'HTTP_PROXY',
    'https_proxy',
    'HTTPS_PROXY',
    'all_proxy',
    'ALL_PROXY',
    'no_proxy',
    'NO_PROXY',
  ]) {
    out[key] = process.env[key] ?? ''
  }
  return out
}

/**
 * Build a tmux session name from the clawx sessionId. tmux only
 * accepts a narrow charset; we slug-ify aggressively and length-cap so
 * a long chat-id doesn't blow past tmux's 128-char limit.
 */
function nameFromSessionId(sessionId: string): string {
  const slug = sessionId.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 96)
  return `${TMUX_NAME_PREFIX}${slug}`
}

/** POSIX single-quote shell escape: wrap in single quotes, then close +
 * literal ' + reopen to embed any literal quotes safely. */
function shQ(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

function buildAgentLaunch(args: {
  agentKind: AgentKind
  cwd: string
  resumeId?: string
  claudeCmd: string
  codexCmd: string
}): { agentSessionId?: string; bannerId: string; cmd: string; pendingSessionId: boolean } {
  if (args.agentKind === 'claude') {
    const id = args.resumeId?.trim() || randomUUID()
    const cliArgs = args.resumeId?.trim()
      ? `--resume ${shQ(id)} --dangerously-skip-permissions`
      : `--session-id ${shQ(id)} --dangerously-skip-permissions`
    return {
      agentSessionId: id,
      bannerId: id,
      pendingSessionId: false,
      cmd: `exec ${shQ(args.claudeCmd)} ${cliArgs}`,
    }
  }

  // Codex (both resume + fresh) launches with `-c check_for_update_on_startup
  // =false`. Without it, codex >= 0.140 opens with a blocking "Update
  // available — 1. Update now / 2. Skip" prompt that our claude-oriented
  // startup-dialog dismissal doesn't recognize, so the REPL hangs (or exits
  // if the prompt gets stray input) and the tmux session dies — the
  // "codex 无响应" failure where Re-attach then can't find the session.
  if (args.resumeId?.trim()) {
    const id = args.resumeId.trim()
    return {
      agentSessionId: id,
      bannerId: id,
      pendingSessionId: false,
      cmd:
        `exec ${shQ(args.codexCmd)} -c check_for_update_on_startup=false ` +
        `resume ${shQ(id)} ` +
        `--cd ${shQ(args.cwd)} ` +
        `--dangerously-bypass-approvals-and-sandbox ` +
        `--dangerously-bypass-hook-trust ` +
        `--no-alt-screen`,
    }
  }

  return {
    bannerId: '(pending)',
    pendingSessionId: true,
    cmd:
      `exec ${shQ(args.codexCmd)} -c check_for_update_on_startup=false ` +
      `--cd ${shQ(args.cwd)} ` +
      `--dangerously-bypass-approvals-and-sandbox ` +
      `--dangerously-bypass-hook-trust ` +
      `--no-alt-screen`,
  }
}

/**
 * Poll capture-pane and dismiss claude REPL's two startup dialogs.
 *
 * Pragmatic, not elegant: we string-match the prompt text so we don't
 * fire "2 Enter" into an already-live REPL (which would treat "2" as a
 * real user prompt). If a future claude release renames the dialogs,
 * the worst outcome is the bot times out and we log + skip — the user
 * just has to attach and accept once manually.
 */
async function acceptStartupDialogs(
  mgr: TmuxMgr,
  tmuxName: string,
): Promise<void> {
  const deadline = Date.now() + 30_000
  let trustHandled = false
  let bypassHandled = false

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    if (!(await mgr.hasSession(tmuxName))) {
      throw new Error('session died before dialogs could be accepted')
    }
    let pane = ''
    try {
      pane = await mgr.capturePane({ name: tmuxName, lines: 80 })
    } catch {
      continue
    }
    if (
      !trustHandled &&
      /Is this a project you (created|trust)|trust this folder/i.test(pane)
    ) {
      // Default selection is "1. Yes" — just Enter accepts it.
      await mgr.sendKeys({ name: tmuxName, text: 'Enter' })
      trustHandled = true
      continue
    }
    if (
      !bypassHandled &&
      /Bypass Permissions mode|Yes, I accept/i.test(pane)
    ) {
      // Default highlighted is "1. No, exit" — must move to "2" first.
      await mgr.sendKeys({ name: tmuxName, text: 'Down' })
      await mgr.sendKeys({ name: tmuxName, text: 'Enter' })
      bypassHandled = true
      continue
    }
    // Settings file validation error → pick "Continue without these
    // settings" (option 3) so we don't hang. The user can fix the
    // underlying ~/.claude/settings.json later; we just want a live
    // REPL.
    if (/Settings Error|Continue without these settings/i.test(pane)) {
      await mgr.sendKeys({ name: tmuxName, text: 'Down' })
      await mgr.sendKeys({ name: tmuxName, text: 'Down' })
      await mgr.sendKeys({ name: tmuxName, text: 'Enter' })
      continue
    }
    // Detect a ready REPL: claude prints its boxed input prompt with
    // a leading `❯` (unicode arrow) and the "Try ..." placeholder.
    // bypassPermissions footer also reliably appears once ready.
    if (
      /❯\s+Try\s+"/i.test(pane) ||
      /bypass permissions on \(shift\+tab/i.test(pane)
    ) {
      return
    }
  }
  // Timed out — caller decides whether to fail or carry on.
  throw new Error(
    `acceptStartupDialogs: timed out (trust=${trustHandled}, bypass=${bypassHandled})`,
  )
}

export function createTmuxOrchestrator(
  deps: TmuxOrchestratorDeps,
): TmuxOrchestrator {
  const mgr = deps.mgr ?? createTmuxMgr()
  const store = deps.store
  const claudeCmd = deps.claudeCmd ?? 'claude'
  const codexCmd = deps.codexCmd ?? (process.env.CODEX_CMD?.trim() || 'codex')

  // Per-sid send queue. Multiple writers (Lark thread, web composer,
  // terminal user typing while we also automate) can race on
  // `tmux send-keys`; tmux itself has no per-pane lock, so two
  // near-simultaneous sends would interleave their byte streams into
  // claude's input box. Serializing per-sid on the daemon side keeps
  // the order intact.
  const sendLocks = new Map<string, Promise<unknown>>()
  async function withSendLock<T>(sid: string, fn: () => Promise<T>): Promise<T> {
    const prev = sendLocks.get(sid) ?? Promise.resolve()
    // Chain ours onto the previous tail. Each caller awaits the prior
    // chain before running, and stores its own promise as the new tail
    // so the NEXT caller awaits us. We don't GC entries — the map is
    // bounded by the number of tmux sessions, which is small (~10).
    const ours = prev.then(fn, fn) // run fn regardless of prev outcome
    sendLocks.set(sid, ours)
    return ours as Promise<T>
  }

  // Per-sid ring buffer of recent sends, capped at 16 entries with
  // 5-minute TTL. Used by turn-done to identify the user message's
  // origin (web / lark / cli) so the fanout can tag it appropriately.
  // Direct terminal input never lands here — falls through as "terminal".
  interface SendRecord {
    text: string
    source: SendSource
    ts: number
  }
  const sendBuffer = new Map<string, SendRecord[]>()
  const SEND_BUFFER_MAX = 16
  const SEND_BUFFER_TTL_MS = 5 * 60_000

  function recordSend(sid: string, text: string, source: SendSource): void {
    const now = Date.now()
    const buf = sendBuffer.get(sid) ?? []
    const fresh = buf.filter((r) => now - r.ts < SEND_BUFFER_TTL_MS)
    fresh.push({ text, source, ts: now })
    if (fresh.length > SEND_BUFFER_MAX) fresh.shift()
    sendBuffer.set(sid, fresh)
  }

  // ─── Delivery watchdog ──────────────────────────────────────────────
  // tmux send-keys can "succeed" (exit 0, chars reach the input buffer)
  // while the claude REPL is too busy / stuck (e.g. on a huge context) to
  // actually submit the prompt — the message silently vanishes with no
  // turn. After each send we wait for a turn-start (confirmTurnStarted);
  // if none arrives we nudge a bare Enter (the un-submitted text usually
  // still sits in the buffer), then warn the caller if it's still dead.
  const deliveryConfirmMs = deps.deliveryConfirmMs ?? 5000
  const onDeliveryUnconfirmed = deps.onDeliveryUnconfirmed
  interface PendingDelivery {
    text: string
    source: SendSource
    tmuxName: string
    retried: boolean
    armedAt: number
    timer: ReturnType<typeof setTimeout>
  }
  const pendingDeliveries = new Map<string, PendingDelivery>()

  function clearDelivery(sessionId: string): void {
    const p = pendingDeliveries.get(sessionId)
    if (!p) return
    clearTimeout(p.timer)
    pendingDeliveries.delete(sessionId)
  }

  function armDelivery(
    sessionId: string,
    tmuxName: string,
    text: string,
    source: SendSource,
  ): void {
    clearDelivery(sessionId) // a newer send supersedes the old watchdog
    const timer = setTimeout(
      () => void onDeliveryTimeout(sessionId),
      deliveryConfirmMs,
    )
    pendingDeliveries.set(sessionId, { text, source, tmuxName, retried: false, armedAt: Date.now(), timer })
  }

  async function onDeliveryTimeout(sessionId: string): Promise<void> {
    const p = pendingDeliveries.get(sessionId)
    if (!p) return
    // Session vanished meanwhile — nothing to retry / warn about.
    if (!(await mgr.hasSession(p.tmuxName))) {
      clearDelivery(sessionId)
      return
    }
    // If the REPL is actively generating, our text is QUEUED by Claude Code
    // (it picks up queued input when the current turn ends) — NOT lost. So
    // don't nudge Enter (pointless mid-turn) and don't warn; just keep waiting
    // silently until a turn actually starts (confirmTurnStarted clears us) or
    // the REPL goes idle. A generous deadline guards a genuinely wedged pane.
    const STUCK_DEADLINE_MS = 20 * 60_000
    let replState = 'unknown'
    try {
      replState = classifyReplState(await mgr.capturePane({ name: p.tmuxName, lines: 80 }))
    } catch {
      /* capture failed — fall through to the normal retry/warn path */
    }
    if (replState === 'generating' && Date.now() - p.armedAt < STUCK_DEADLINE_MS) {
      p.timer = setTimeout(() => void onDeliveryTimeout(sessionId), deliveryConfirmMs)
      return
    }
    if (!p.retried) {
      // First miss: nudge a bare Enter to submit whatever sits in the
      // buffer. We deliberately DON'T re-type the text — if the original
      // chars did land, re-typing would double them; a blank submit is
      // harmless when the buffer is empty (claude ignores it).
      p.retried = true
      log.warn('tmux delivery unconfirmed — nudging Enter', {
        sessionId,
        tmuxName: p.tmuxName,
        textPreview: p.text.slice(0, 60),
      })
      try {
        await mgr.sendKeys({ name: p.tmuxName, text: '', pressEnter: true })
      } catch (err: any) {
        log.warn('tmux delivery retry sendKeys failed', {
          sessionId,
          err: err?.message ?? String(err),
        })
      }
      p.timer = setTimeout(
        () => void onDeliveryTimeout(sessionId),
        deliveryConfirmMs,
      )
    } else {
      // Still no turn-start after the nudge → give up + let caller warn.
      log.warn('tmux delivery failed after retry', {
        sessionId,
        tmuxName: p.tmuxName,
        textPreview: p.text.slice(0, 60),
      })
      clearDelivery(sessionId)
      onDeliveryUnconfirmed?.({ sessionId, text: p.text, source: p.source })
    }
  }

  // Shared helper used both by create() (right after spawn) and the
  // public applyDisplayLabel() (startup backfill / future label edits).
  // Sets THREE things in one shot, all derived from the same display
  // title:
  //   1. status-left → "[<title> · YYYY-MM-DD · <sid8>] " (bottom bar)
  //   2. window-0 name → "<title>" (with set-titles on, propagates to
  //      the terminal emulator's tab title so multi-tab attach panes
  //      are distinguishable at a glance)
  //   3. set-titles on + set-titles-string '#W' (enables item 2)
  // Falls back to basename(cwd) when no label set — better than the
  // raw `clawx-cli-tmux-xxxx` slug everywhere.
  async function applyDisplayLabelImpl(sessionId: string): Promise<void> {
    const entry = store.get(sessionId)
    if (!entry) return
    if (!(await mgr.hasSession(entry.tmuxName))) return
    const labelRaw = entry.label?.trim() || path.basename(entry.cwd) || entry.sessionId
    const safeLabel = labelRaw.slice(0, 30).replace(/[\r\n]/g, ' ')
    // Asia/Shanghai is the operator default; sv-SE locale gives
    // "YYYY-MM-DD" without locale-specific separators.
    const createdAtDate = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(entry.createdAt))
    try {
      // tmux 3.6 quirk: `#{=N:literal}` and `#{=N:#S}` both expand to
      // empty — `=N:` only works when the inner is a full format
      // reference like `#{session_name}`. So label + date go in
      // verbatim; only the sid uses the format truncation.
      await mgr.setSessionOption({
        name: entry.tmuxName,
        option: 'status-left',
        value: `[${safeLabel} · ${createdAtDate} · #{=-8:#{session_name}}] `,
      })
      // Window name → terminal title. Omit index so tmux targets the
      // active window (works regardless of user's base-index config).
      await mgr.renameWindow({ name: entry.tmuxName, title: safeLabel })
      // Tell tmux to propagate window name to the terminal emulator's
      // OSC title. `set-titles-string '#W'` keeps the title focused
      // on the window name only (instead of the noisy default with
      // session:index breakdown).
      await mgr.setSessionOption({
        name: entry.tmuxName,
        option: 'set-titles',
        value: 'on',
      })
      await mgr.setSessionOption({
        name: entry.tmuxName,
        option: 'set-titles-string',
        value: '#W',
      })
    } catch (err: any) {
      log.debug('tmux applyDisplayLabel failed', {
        sessionId,
        err: err?.message ?? String(err),
      })
    }
  }

  return {
    async create(opts: CreateOptions): Promise<TmuxSessionEntry> {
      const agentKind: AgentKind = opts.agentKind ?? 'claude'
      // Lark thread carried over from a prior (now-dead) session that
      // owned the same agent session id. On resume we re-bind the new
      // process to that same thread instead of minting a fresh one.
      let prior: TmuxSessionEntry | undefined

      const existing = store.get(opts.sessionId)
      if (existing) {
        const alive = await mgr.hasSession(existing.tmuxName)
        if (alive) return existing
        log.warn('tmux session lost — respawning', {
          sessionId: opts.sessionId,
          tmuxName: existing.tmuxName,
        })
        if (opts.resumeUuid?.trim()) prior = existing
        store.remove(opts.sessionId)
      }

      // Resume invariant: at most one tmux session may own a given
      // agent session id. This is critical for both Claude and Codex:
      // two processes appending to the same transcript make hook routing
      // ambiguous and can fan out to the wrong Lark thread.
      if (opts.resumeUuid?.trim()) {
        const resumeId = opts.resumeUuid.trim()
        const dup = store.getByAgentSession(agentKind, resumeId)
        if (dup) {
          const stillAlive = await mgr.hasSession(dup.tmuxName)
          if (stillAlive) {
            throw new Error(
              `${agentKind} session ${resumeId} is already in use by session ${dup.sessionId} ` +
                `(tmux=${dup.tmuxName}). kill it first or attach with ` +
                `\`tmux attach -t ${dup.tmuxName}\`.`,
            )
          }
          log.warn('stale resume entry — removing before respawn', {
            staleSessionId: dup.sessionId,
            agentKind,
            sessionId: resumeId,
          })
          if (!prior) prior = dup
          store.remove(dup.sessionId)
        }
      }

      const tmuxName = nameFromSessionId(opts.sessionId)
      const isResume = !!opts.resumeUuid?.trim()
      const launch = buildAgentLaunch({
        agentKind,
        cwd: opts.cwd,
        resumeId: opts.resumeUuid,
        claudeCmd,
        codexCmd,
      })
      const agentSessionId = launch.agentSessionId
      const claudeUuid = agentKind === 'claude' ? agentSessionId : undefined

      const banner = isResume
        ? `🔧 clawx tmux session (resumed)\n  sid: %s\n  agent: %s\n  id: %s\n  cwd: %s\n\n`
        : `🔧 clawx tmux session\n  sid: %s\n  agent: %s\n  id: %s\n  cwd: %s\n\n`
      const cmd =
        `printf '${banner}' ` +
        `${shQ(opts.sessionId)} ${shQ(agentKind)} ${shQ(launch.bannerId)} ${shQ(opts.cwd)}; ` +
        launch.cmd
      await mgr.newSession({
        name: tmuxName,
        cwd: opts.cwd,
        cmd,
        env: collectClaudeRuntimeEnv(),
      })

      const entry: TmuxSessionEntry = {
        sessionId: opts.sessionId,
        tmuxName,
        cwd: opts.cwd,
        agentKind,
        agentSessionId,
        agentSessionPending: launch.pendingSessionId,
        claudeUuid,
        label: opts.label ?? prior?.label,
        createdAt: new Date().toISOString(),
        ...(prior
          ? {
              threadId: prior.threadId,
              chatId: prior.chatId,
              rootMessageId: prior.rootMessageId,
            }
          : {}),
      }
      store.upsert(entry)
      log.info('tmux session created', {
        sessionId: opts.sessionId,
        tmuxName,
        agentKind,
        agentSessionId,
        claudeUuid,
        cwd: opts.cwd,
        resumed: isResume,
      })

      await applyDisplayLabelImpl(opts.sessionId)

      if (agentKind === 'codex' && launch.pendingSessionId) {
        const afterMs = Date.now() - 2000
        void waitForNewestCodexSessionForCwd({ cwd: opts.cwd, afterMs, timeoutMs: 20_000 })
          .then((found) => {
            if (!found) return
            try {
              store.patch(opts.sessionId, {
                agentSessionId: found.id,
                transcriptPath: found.path,
                agentSessionPending: false,
              })
              log.info('codex session id backfilled', {
                sessionId: opts.sessionId,
                codexSessionId: found.id,
                transcriptPath: found.path,
              })
            } catch (err: any) {
              log.warn('codex session id backfill failed', {
                sessionId: opts.sessionId,
                err: err?.message ?? String(err),
              })
            }
          })
          .catch((err: any) => {
            log.warn('codex session id backfill scan failed', {
              sessionId: opts.sessionId,
              err: err?.message ?? String(err),
            })
          })
      }

      // Auto-accept only applies to Claude's startup dialogs. Codex is
      // launched with --dangerously-bypass-* flags and --no-alt-screen.
      if (agentKind === 'claude') {
        try {
          await acceptStartupDialogs(mgr, tmuxName)
        } catch (err: any) {
          log.warn('tmux auto-accept failed', {
            sessionId: opts.sessionId,
            tmuxName,
            err: err?.message ?? String(err),
          })
        }
      }
      return entry
    },

    async send(sessionId: string, text: string, source: SendSource): Promise<void> {
      await withSendLock(sessionId, async () => {
        const entry = store.get(sessionId)
        if (!entry) {
          throw new Error(`no tmux session for ${sessionId}`)
        }
        if (!(await mgr.hasSession(entry.tmuxName))) {
          throw new Error(
            `tmux session ${entry.tmuxName} is gone — recreate with create()`,
          )
        }
        // Record BEFORE send so turn-done can identify even if the
        // jsonl writes happen faster than expected.
        recordSend(sessionId, text, source)
        await mgr.sendKeys({ name: entry.tmuxName, text, pressEnter: true })
        // Watchdog: a turn-start (confirmTurnStarted) cancels it; if none
        // arrives the REPL likely swallowed the input → nudge Enter, then
        // warn via onDeliveryUnconfirmed.
        armDelivery(sessionId, entry.tmuxName, text, source)
      })
    },

    confirmTurnStarted(sessionId: string): void {
      clearDelivery(sessionId)
    },

    async interrupt(sessionId: string): Promise<void> {
      await withSendLock(sessionId, async () => {
        const entry = store.get(sessionId)
        if (!entry) throw new Error(`no tmux session for ${sessionId}`)
        if (!(await mgr.hasSession(entry.tmuxName))) {
          throw new Error(
            `tmux session ${entry.tmuxName} is gone — recreate with create()`,
          )
        }
        // Esc interrupts the current generation / cancels a prompt; any
        // in-flight delivery watchdog is moot now, so drop it.
        clearDelivery(sessionId)
        await mgr.sendKey({ name: entry.tmuxName, key: entry.agentKind === 'codex' ? 'C-c' : 'Escape' })
      })
    },

    identifySendSource(sessionId: string, text: string): SendSource | null {
      const buf = sendBuffer.get(sessionId)
      if (!buf) return null
      const now = Date.now()
      // Match newest-first so back-to-back identical sends still
      // pop in LIFO order. Trim TTL-expired entries on the way.
      let found: SendSource | null = null
      const kept: SendRecord[] = []
      for (let i = buf.length - 1; i >= 0; i--) {
        const r = buf[i]!
        if (now - r.ts >= SEND_BUFFER_TTL_MS) continue
        if (!found && r.text === text) {
          found = r.source
          continue // drop this match so a duplicate text doesn't re-match
        }
        kept.unshift(r)
      }
      sendBuffer.set(sessionId, kept)
      return found
    },

    peekSendSource(sessionId: string, text: string): SendSource | null {
      const buf = sendBuffer.get(sessionId)
      if (!buf) return null
      const now = Date.now()
      for (let i = buf.length - 1; i >= 0; i--) {
        const r = buf[i]!
        if (now - r.ts >= SEND_BUFFER_TTL_MS) continue
        if (r.text === text) return r.source
      }
      return null
    },

    async capture(sessionId: string, lines = 500): Promise<string> {
      const entry = store.get(sessionId)
      if (!entry) throw new Error(`no tmux session for ${sessionId}`)
      return mgr.capturePane({ name: entry.tmuxName, lines })
    },

    async peekReplState(sessionId: string): Promise<string> {
      const entry = store.get(sessionId)
      if (!entry) return ''
      try {
        return classifyReplState(await mgr.capturePane({ name: entry.tmuxName, lines: 80 }))
      } catch {
        return ''
      }
    },

    async kill(sessionId: string): Promise<void> {
      const entry = store.get(sessionId)
      if (!entry) return
      await mgr.killSession(entry.tmuxName)
      store.remove(sessionId)
      log.info('tmux session killed', {
        sessionId,
        tmuxName: entry.tmuxName,
      })
    },

    get(sessionId: string): TmuxSessionEntry | undefined {
      return store.get(sessionId)
    },

    list(): TmuxSessionEntry[] {
      return store.entries()
    },

    applyDisplayLabel: applyDisplayLabelImpl,
  }
}
