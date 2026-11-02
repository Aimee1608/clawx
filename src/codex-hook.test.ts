import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveCodexHookSession } from './codex-hook.js'
import { TmuxSessionStore } from './tmux-session-store.js'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

describe('Codex hook origin', () => {
  it('uses the actual pane instead of another pending session in the same directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawx-hook-origin-'))
    vi.stubEnv('CLAWX_DATA_DIR', dir)
    vi.stubEnv('TMUX_PANE', '%42')
    const store = new TmuxSessionStore()
    try {
      for (const sessionId of ['dead', 'live']) {
        store.upsert({ sessionId, tmuxName: `xclaw-${sessionId}`, cwd: '/same',
          agentKind: 'codex', createdAt: new Date().toISOString() })
      }
      vi.mocked(execFileSync).mockReturnValue('xclaw-live\n')
      expect(resolveCodexHookSession('cx')).toBe('live')
      expect(execFileSync).toHaveBeenCalledWith('tmux',
        ['display-message', '-p', '-t', '%42', '#{session_name}'], expect.anything())
      store.patch('live', { agentSessionId: 'other' })
      expect(resolveCodexHookSession('cx')).toBeNull()
      vi.mocked(execFileSync).mockReturnValue('unmanaged\n')
      expect(resolveCodexHookSession('cx')).toBeNull()
      vi.stubEnv('TMUX_PANE', '')
      expect(resolveCodexHookSession('cx')).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
