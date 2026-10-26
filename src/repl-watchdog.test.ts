import { describe, expect, it, vi } from 'vitest'
import { createReplWatchdog } from './repl-watchdog.js'
import type { TmuxSessionEntry, TmuxSessionStore } from './tmux-session-store.js'

describe('Codex error recovery', () => {
  const entry: TmuxSessionEntry = { sessionId: 'codex-test', agentKind: 'codex',
    tmuxName: 'test', cwd: '/tmp', createdAt: '2026-10-13T00:00:00Z' }

  it('recovers a terminal error on the first scan even without a prompt hook', async () => {
    const status = vi.fn().mockResolvedValueOnce('error').mockResolvedValue(false)
    const trigger = vi.fn().mockResolvedValue(undefined)
    const watchdog = createReplWatchdog({
      store: { entries: () => [entry] } as unknown as TmuxSessionStore,
      capture: vi.fn(), postWarning: vi.fn(), triggerTurnDone: trigger,
      codexHasFinishedReply: status,
    })
    await watchdog.scanOnce()
    expect(trigger).toHaveBeenCalledTimes(1)
    await watchdog.scanOnce()
    expect(trigger).toHaveBeenCalledTimes(1)
  })

  it('keeps the two-scan grace period for successful turns', async () => {
    const trigger = vi.fn().mockResolvedValue(undefined)
    const watchdog = createReplWatchdog({
      store: { entries: () => [{ ...entry, currentTurnUserMessageId: 'prompt' }] } as unknown as TmuxSessionStore,
      capture: vi.fn(), postWarning: vi.fn(), triggerTurnDone: trigger,
      codexHasFinishedReply: vi.fn().mockResolvedValue(true),
    })
    await watchdog.scanOnce()
    expect(trigger).not.toHaveBeenCalled()
    await watchdog.scanOnce()
    expect(trigger).toHaveBeenCalledTimes(1)
  })
})
