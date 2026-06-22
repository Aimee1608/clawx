import { log } from './logger.js'
import type { TmuxSessionStore, TmuxSessionEntry } from './tmux-session-store.js'

/**
 * Coarse REPL state inferred from a tmux pane capture. The claude REPL
 * doesn't fire a hook for every situation we care about — a turn that
 * dead-ends on "tool call could not be parsed", or a blocking dialog
 * (rate-limit / permission / AskUserQuestion), leaves NO Stop-hook event,
 * so the daemon would never know. This watchdog reads the screen instead.
 */
export type ReplState =
  | 'generating' // claude is actively streaming a reply
  | 'rate-limit' // blocked on the /rate-limit-options dialog
  | 'dialog' // blocked on a generic numbered choice dialog (perm / trust / question)
  | 'idle' // sitting at the input prompt, nothing running
  | 'unknown' // couldn't tell (e.g. mid-redraw)

/**
 * Classify a pane capture. Pure + priority-ordered so it's trivially
 * testable against recorded captures.
 *
 * Priority: rate-limit > dialog > generating > idle. We scan the WHOLE
 * capture (not just the tail) because claude renders dialogs a few lines
 * above the status footer.
 */
export function classifyReplState(capture: string): ReplState {
  const t = capture
  // Rate-limit: claude hit the usage cap and is blocking on a choice.
  if (/rate-limit-options|Stop and wait for limit to reset/i.test(t)) {
    return 'rate-limit'
  }
  // Generic blocking dialog: a numbered menu awaiting Enter/Esc. Covers
  // permission prompts, the trust dialog, AskUserQuestion, etc. The
  // "Esc to cancel" + "Enter to confirm/select" footer is the marker.
  if (/Esc to cancel/i.test(t) && /Enter to (confirm|select|continue|submit)/i.test(t)) {
    return 'dialog'
  }
  // Actively generating: claude prints "esc to interrupt" while streaming.
  if (/esc to interrupt/i.test(t)) {
    return 'generating'
  }
  // Idle: the bypass-permissions footer is present but WITHOUT the
  // "esc to interrupt" hint → nothing is running, the REPL awaits input.
  if (/bypass permissions on \(shift\+tab/i.test(t)) {
    return 'idle'
  }
  return 'unknown'
}

export interface ReplWatchdogDeps {
  store: TmuxSessionStore
  /** Capture the session's pane (tail is enough). Should resolve to '' /
   * reject when the session is gone — the watchdog just skips it. */
  capture: (sessionId: string) => Promise<string>
  /** Post a plain warning into the session's Lark thread. */
  postWarning: (entry: TmuxSessionEntry, text: string) => Promise<void>
  /** Recover a turn whose Stop hook never fired: re-runs the turn-done
   * path so the reply still reaches the thread. MUST be idempotent — the
   * turn-done handler's sinceMs/lastTurnAt dedup makes a duplicate a
   * no-op, so racing a late real Stop hook is harmless. */
  triggerTurnDone: (entry: TmuxSessionEntry) => Promise<void>
  /** Codex sessions have no claude-style pane UI to classify, so the
   * watchdog can't read their screen. Instead the daemon checks the codex
   * transcript: returns true when the in-progress turn already has a
   * finished assistant reply past the last turn boundary — i.e. the turn
   * completed but turn-done never landed. Absent → codex sessions are not
   * watched. */
  codexHasFinishedReply?: (entry: TmuxSessionEntry) => Promise<boolean>
  /** Poll interval. Default 60s. */
  intervalMs?: number
}

export interface ReplWatchdog {
  start(): void
  stop(): void
  /** One scan pass over all sessions. Exposed for tests. */
  scanOnce(): Promise<void>
}

export function createReplWatchdog(deps: ReplWatchdogDeps): ReplWatchdog {
  const intervalMs = deps.intervalMs ?? 60_000
  // Per-session latch of the last "stuck" state we acted on, so we don't
  // re-warn every poll. For `idle` it doubles as a one-round grace timer:
  // we only recover after seeing idle TWICE in a row, ruling out a brief
  // gap between tool calls. Cleared when the session is healthy again.
  const latch = new Map<string, ReplState>()

  async function handleSession(entry: TmuxSessionEntry): Promise<void> {
    // Only sessions with a turn in progress. turn-start sets
    // currentTurnUserMessageId; turn-done clears it. No marker → idle is
    // expected, nothing to watch.
    if (!entry.currentTurnUserMessageId) {
      latch.delete(entry.sessionId)
      return
    }
    // Codex: no claude pane UI to classify. Use the transcript signal — a
    // finished reply past the last turn boundary means the turn is done
    // but turn-done never fanned out (Stop hook missed). One-round grace
    // (latch) dodges a mid-flush read; then replay via triggerTurnDone,
    // which routes codex to agent-turn-done. Idempotent via the handler's
    // sinceMs/lastTurnAt dedup.
    if ((entry.agentKind ?? 'claude') === 'codex') {
      if (!deps.codexHasFinishedReply) return
      let finished = false
      try {
        finished = await deps.codexHasFinishedReply(entry)
      } catch {
        return
      }
      if (!finished) {
        latch.delete(entry.sessionId)
        return
      }
      if (latch.get(entry.sessionId) !== 'idle') {
        latch.set(entry.sessionId, 'idle')
        return
      }
      latch.delete(entry.sessionId)
      try {
        await deps.triggerTurnDone(entry)
        log.info('repl-watchdog: recovered codex turn-done', {
          sessionId: entry.sessionId,
          agentSessionId: entry.agentSessionId,
        })
      } catch (err: any) {
        log.warn('repl-watchdog: codex recover failed', {
          sessionId: entry.sessionId,
          err: err?.message ?? String(err),
        })
      }
      return
    }
    let capture = ''
    try {
      capture = await deps.capture(entry.sessionId)
    } catch {
      return // session gone / capture failed — skip this round
    }
    const state = classifyReplState(capture)

    if (state === 'generating' || state === 'unknown') {
      latch.delete(entry.sessionId) // healthy / indeterminate — reset
      return
    }

    if (state === 'rate-limit' || state === 'dialog') {
      if (latch.get(entry.sessionId) === state) return // already warned
      latch.set(entry.sessionId, state)
      const msg =
        state === 'rate-limit'
          ? '⚠️ Claude 撞到用量上限，卡在 /rate-limit-options 对话框，消息发不进去——请去终端选择「等待重置 / 升级」。'
          : '⚠️ Claude 正等你在对话框里做选择（权限 / 确认 / 提问），消息发不进去——请去终端处理。'
      try {
        await deps.postWarning(entry, msg)
        log.info('repl-watchdog: warned stuck dialog', { sessionId: entry.sessionId, state })
      } catch (err: any) {
        log.warn('repl-watchdog: warn post failed', {
          sessionId: entry.sessionId,
          err: err?.message ?? String(err),
        })
      }
      return
    }

    // state === 'idle' — turn still marked in-progress but nothing is
    // running. Could be a brief gap between tools, so require TWO
    // consecutive idle observations before recovering.
    if (latch.get(entry.sessionId) !== 'idle') {
      latch.set(entry.sessionId, 'idle')
      return
    }
    latch.delete(entry.sessionId)
    try {
      await deps.triggerTurnDone(entry)
      log.info('repl-watchdog: recovered missing turn-done', {
        sessionId: entry.sessionId,
        claudeUuid: entry.claudeUuid,
      })
    } catch (err: any) {
      log.warn('repl-watchdog: triggerTurnDone failed', {
        sessionId: entry.sessionId,
        err: err?.message ?? String(err),
      })
    }
  }

  async function scanOnce(): Promise<void> {
    for (const entry of deps.store.entries()) {
      await handleSession(entry)
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null
  return {
    start() {
      if (timer) return
      timer = setInterval(() => void scanOnce(), intervalMs)
      // Don't keep the event loop alive just for the watchdog.
      if (typeof timer.unref === 'function') timer.unref()
      log.info('repl-watchdog started', { intervalMs })
    },
    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
    scanOnce,
  }
}
