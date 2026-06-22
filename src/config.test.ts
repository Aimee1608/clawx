import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'

import { brand, configDir, dataDir, expandHomePath } from './config.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('brand', () => {
  it('defaults to clawx when unset', () => {
    vi.stubEnv('CLAWX_BRAND', '')
    expect(brand()).toBe('clawx')
  })

  it('honors a valid CLAWX_BRAND (lets a throwaway instance isolate)', () => {
    vi.stubEnv('CLAWX_BRAND', 'clawx-dev')
    expect(brand()).toBe('clawx-dev')
  })

  it('falls back to clawx on a path-unsafe brand', () => {
    vi.stubEnv('CLAWX_BRAND', 'bad/name')
    expect(brand()).toBe('clawx')
  })

  it('rejects whitespace-only brand', () => {
    vi.stubEnv('CLAWX_BRAND', '   ')
    expect(brand()).toBe('clawx')
  })
})

describe('configDir', () => {
  it('defaults to ~/.config/clawx', () => {
    vi.stubEnv('CLAWX_BRAND', '')
    vi.stubEnv('XDG_CONFIG_HOME', '')
    expect(configDir()).toBe(path.join(os.homedir(), '.config', 'clawx'))
  })

  it('honors XDG_CONFIG_HOME', () => {
    vi.stubEnv('CLAWX_BRAND', '')
    vi.stubEnv('XDG_CONFIG_HOME', '/tmp/xdg-home')
    expect(configDir()).toBe(path.join('/tmp/xdg-home', 'clawx'))
  })

  it('isolates per brand (the room/solo bridge reads lark-apps.json from here)', () => {
    vi.stubEnv('CLAWX_BRAND', 'clawx-dev')
    vi.stubEnv('XDG_CONFIG_HOME', '')
    expect(configDir()).toBe(path.join(os.homedir(), '.config', 'clawx-dev'))
  })
})

describe('dataDir', () => {
  it('defaults to ~/.local/share/clawx', () => {
    vi.stubEnv('CLAWX_DATA_DIR', '')
    vi.stubEnv('XDG_DATA_HOME', '')
    vi.stubEnv('CLAWX_BRAND', '')
    expect(dataDir()).toBe(path.join(os.homedir(), '.local', 'share', 'clawx'))
  })

  it('honors XDG_DATA_HOME (symmetry with configDir)', () => {
    vi.stubEnv('CLAWX_DATA_DIR', '')
    vi.stubEnv('XDG_DATA_HOME', '/tmp/xdg-data')
    vi.stubEnv('CLAWX_BRAND', '')
    expect(dataDir()).toBe(path.join('/tmp/xdg-data', 'clawx'))
  })

  it('honors CLAWX_DATA_DIR override verbatim (wins over XDG)', () => {
    vi.stubEnv('CLAWX_DATA_DIR', '/tmp/clawx-data')
    vi.stubEnv('XDG_DATA_HOME', '/tmp/xdg-data')
    expect(dataDir()).toBe('/tmp/clawx-data')
  })

  it('isolates per brand when no explicit data dir', () => {
    vi.stubEnv('CLAWX_DATA_DIR', '')
    vi.stubEnv('XDG_DATA_HOME', '')
    vi.stubEnv('CLAWX_BRAND', 'clawx-dev')
    expect(dataDir()).toBe(path.join(os.homedir(), '.local', 'share', 'clawx-dev'))
  })
})

describe('expandHomePath', () => {
  it('expands a bare ~', () => {
    expect(expandHomePath('~')).toBe(os.homedir())
  })

  it('expands ~/sub/dir', () => {
    expect(expandHomePath('~/work/proj')).toBe(path.join(os.homedir(), 'work/proj'))
  })

  it('leaves absolute paths untouched', () => {
    expect(expandHomePath('/abs/path')).toBe('/abs/path')
  })

  it('leaves relative paths untouched', () => {
    expect(expandHomePath('rel/path')).toBe('rel/path')
  })
})
