import { once } from 'node:events'
import { expect, it } from 'vitest'
import { startWebServer } from './web.js'
import { SessionStore } from './session-store.js'

it.each([undefined, '0.0.0.0'])('uses loopback unless a public binding is explicitly requested (%s)', async (host) => {
  const server = startWebServer({ port: 0, host, sessionStore: new SessionStore(), claudeCwd: '/tmp', mode: 'ws', instanceId: 'test' })
  try {
    await once(server, 'listening')
    const address = server.address() as { address: string; port: number }
    expect(address.address).toBe(host ?? '127.0.0.1')
    const status = await fetch(`http://127.0.0.1:${address.port}/api/status`).then((r) => r.json())
    expect(status.bindHost).toBe(host ?? '127.0.0.1')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
