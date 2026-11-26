import { describe, expect, it, vi } from 'vitest'
import { classifyReplState, createReplWatchdog } from './repl-watchdog.js'
import type { TmuxSessionEntry, TmuxSessionStore } from './tmux-session-store.js'

describe('Claude error recovery', () => {
  const entry: TmuxSessionEntry = { sessionId: 'claude-test', agentKind: 'claude',
    tmuxName: 'test', cwd: '/tmp', createdAt: '2026-11-04T00:00:00Z' }

  it.each([undefined, 'prompt'])('recovers an API error without a Stop hook (prompt=%s)', async (prompt) => {
    const trigger = vi.fn().mockResolvedValue(undefined)
    const capture = vi.fn()
    const watchdog = createReplWatchdog({
      store: { entries: () => [{ ...entry, currentTurnUserMessageId: prompt }] } as unknown as TmuxSessionStore,
      capture, postWarning: vi.fn(), triggerTurnDone: trigger,
      claudeHasFinishedError: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
    })
    await watchdog.scanOnce()
    expect(trigger).toHaveBeenCalledTimes(1)
    expect(capture).not.toHaveBeenCalled()
    await watchdog.scanOnce()
    expect(trigger).toHaveBeenCalledTimes(1)
  })

  it('recognizes the current idle footer after an API error', () => {
    expect(classifyReplState('● API Error: 503 no eligible upstream account is currently available.\n❯\n  ⏵⏵ bypass permissions on · 2 shells · ↓ to manage')).toBe('idle')
    expect(classifyReplState('esc to interrupt\n  ⏵⏵ bypass permissions on · 2 shells')).toBe('generating')
  })
})

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
