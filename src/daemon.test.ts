import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'

const mock = vi.hoisted(() => ({
  connect: vi.fn((cb: any) => cb(null)),
  describe: vi.fn((name: string, cb: any) => cb(null, [])),
  start: vi.fn(), stop: vi.fn((name: string, cb: any) => cb(null)),
  disconnect: vi.fn(),
}))
vi.mock('pm2', () => ({ default: mock }))
import { daemonStart } from './daemon.js'

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

describe('daemon process selection', () => {
  it('drops inherited PM2 metadata while preserving application and proxy settings', async () => {
    for (const key of ['pm_exec_path', 'pm_cwd', 'pm_id', 'name', 'args', 'exec_interpreter', 'exec_mode', 'node_args', 'status', 'axm_options']) vi.stubEnv(key, '/old/deployment')
    vi.stubEnv('https_proxy', 'http://127.0.0.1:7890')
    vi.stubEnv('PM2_HOME', '/test/pm2')
    vi.stubEnv('CLAWX_DATA_DIR', '/test/data')
    mock.start.mockImplementation((opts: any, cb: any) => cb(null, [{ pid: 42, pm_id: 1,
      pm2_env: { pm_exec_path: opts.script } }]))
    await daemonStart({ overrides: {} })
    const opts = mock.start.mock.calls[0]![0]
    for (const key of ['pm_exec_path', 'pm_cwd', 'pm_id', 'name', 'args', 'exec_interpreter', 'exec_mode', 'node_args', 'status', 'axm_options']) expect(opts.env).not.toHaveProperty(key)
    expect(opts.env).toMatchObject({ https_proxy: 'http://127.0.0.1:7890', PM2_HOME: '/test/pm2', CLAWX_DATA_DIR: '/test/data' })
    expect(mock.stop).not.toHaveBeenCalled()
  })

  it('stops a mismatched deployment instead of reporting it as successfully loaded', async () => {
    mock.start.mockImplementation((opts: any, cb: any) => cb(null, [{ pid: 42,
      pm2_env: { pm_exec_path: fileURLToPath(import.meta.url) } }]))
    await expect(daemonStart({ overrides: {} })).rejects.toThrow(/daemon script mismatch/)
    expect(mock.stop).toHaveBeenCalledWith('xclaw', expect.any(Function))
    expect(mock.disconnect).toHaveBeenCalled()
  })
})
