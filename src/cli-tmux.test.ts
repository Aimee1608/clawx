import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))

const { spawnSync } = await import('node:child_process')
const { sessionState } = await import('./cli-tmux.js')

const mocked = vi.mocked(spawnSync)

/** has-session ok → list-panes returns `paneLine` → ps returns `psArgs` */
function stubTmux(paneLine: string, psArgs = '') {
  mocked.mockReset()
  mocked.mockImplementation(((cmd: string, args: string[]) => {
    if (args?.[0] === 'has-session') return { status: 0 } as any
    if (args?.[0] === 'list-panes') return { status: 0, stdout: `${paneLine}\n` } as any
    if (cmd === 'ps') return { status: 0, stdout: psArgs } as any
    return { status: 1, stdout: '' } as any
  }) as any)
}

afterEach(() => mocked.mockReset())

describe('sessionState', () => {
  it('keeps a codex session alive when tmux only sees the node interpreter', () => {
    // 真实回归:pane_current_command 是 "node",据此判 stale 会让 prune 杀掉活会话
    stubTmux('node 1540069 0', 'node /run/user/1001/fnm/bin/codex -c foo resume 019ffef4')
    expect(sessionState('tmux', 'clawx-x', 'codex')).toBe('alive')
  })

  it('matches claude directly from pane_current_command (no ps needed)', () => {
    stubTmux('claude 3231593 0')
    expect(sessionState('tmux', 'clawx-x', 'claude')).toBe('alive')
  })

  it('does not call ps when the pane command already matches', () => {
    stubTmux('claude 3231593 0')
    sessionState('tmux', 'clawx-x', 'claude')
    expect(mocked.mock.calls.some(([c]) => c === 'ps')).toBe(false)
  })

  it('reports stale when the agent kind does not match the real process', () => {
    stubTmux('claude 3231593 0', 'claude --session-id abc')
    expect(sessionState('tmux', 'clawx-x', 'codex')).toBe('stale')
  })

  it('reports stale for a pane that fell back to a shell', () => {
    stubTmux('zsh 1591833 0', '-zsh')
    expect(sessionState('tmux', 'clawx-x', 'claude')).toBe('stale')
  })

  it('reports stale for a dead pane without consulting ps', () => {
    stubTmux('node 1540069 1', 'node .../codex resume x')
    expect(sessionState('tmux', 'clawx-x', 'codex')).toBe('stale')
  })

  it('reports stale when the process already exited (ps empty)', () => {
    stubTmux('node 1540069 0', '')
    expect(sessionState('tmux', 'clawx-x', 'codex')).toBe('stale')
  })

  it('reports gone when the tmux session does not exist', () => {
    mocked.mockReset()
    mocked.mockImplementation((() => ({ status: 1, stdout: '' })) as any)
    expect(sessionState('tmux', 'clawx-x', 'claude')).toBe('gone')
  })
})
