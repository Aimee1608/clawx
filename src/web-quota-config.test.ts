import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { expect, it, vi } from 'vitest'
import { startWebServer } from './web.js'
import { SessionStore } from './session-store.js'

it('does not expose quota credentials through the web config response', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawx-quota-config-'))
  vi.stubEnv('XDG_CONFIG_HOME', dir)
  vi.stubEnv('CLAWX_BRAND', 'clawx')
  fs.mkdirSync(path.join(dir, 'clawx'))
  fs.writeFileSync(path.join(dir, 'clawx/config.json'), JSON.stringify({
    claudeQuota: { baseUrl: 'https://quota.example', apiKey: 'private-quota-credential' },
  }), { mode: 0o600 })
  const server = startWebServer({ port: 0, host: '127.0.0.1', sessionStore: new SessionStore(),
    claudeCwd: dir, mode: 'ws', instanceId: 'test' })
  try {
    await once(server, 'listening')
    const { port } = server.address() as { port: number }
    const response = await fetch(`http://127.0.0.1:${port}/api/config`)
    expect(response.status).toBe(200)
    expect(await response.text()).not.toContain('private-quota-credential')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    vi.unstubAllEnvs()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
