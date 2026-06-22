import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'

import { defaultSessionsPath } from './session-store.js'
import { defaultTmuxSessionsPath } from './tmux-session-store.js'
import { schedulesPath } from './schedule-store.js'
import { defaultWorkspaceRoot } from './workspace.js'

// After unifying every solo-side store on config.dataDir(), a throwaway
// instance (CLAWX_BRAND / CLAWX_DATA_DIR) isolates solo state the same way
// the room bridge already isolates rooms. These guard that consistency.
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('solo store paths follow dataDir()', () => {
  it('defaultSessionsPath honors CLAWX_DATA_DIR', () => {
    vi.stubEnv('CLAWX_DATA_DIR', '/tmp/d')
    expect(defaultSessionsPath()).toBe(path.join('/tmp/d', 'sessions.json'))
  })

  it('defaultTmuxSessionsPath isolates per brand', () => {
    vi.stubEnv('CLAWX_DATA_DIR', '')
    vi.stubEnv('XDG_DATA_HOME', '')
    vi.stubEnv('CLAWX_BRAND', 'clawx-dev')
    expect(defaultTmuxSessionsPath()).toBe(
      path.join(os.homedir(), '.local', 'share', 'clawx-dev', 'tmux-sessions.json'),
    )
  })

  it('schedulesPath honors CLAWX_DATA_DIR', () => {
    vi.stubEnv('CLAWX_DATA_DIR', '/tmp/d')
    expect(schedulesPath()).toBe(path.join('/tmp/d', 'schedules.json'))
  })

  it('defaultWorkspaceRoot defaults to ~/.local/share/clawx/workspaces', () => {
    vi.stubEnv('CLAWX_DATA_DIR', '')
    vi.stubEnv('XDG_DATA_HOME', '')
    vi.stubEnv('CLAWX_BRAND', '')
    expect(defaultWorkspaceRoot()).toBe(path.join(os.homedir(), '.local', 'share', 'clawx', 'workspaces'))
  })
})
