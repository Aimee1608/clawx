import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultAgent, resolveNewSessionAgent } from './config.js'
import { startWebServer } from './web.js'
import { SessionStore } from './session-store.js'
import { TmuxSessionStore } from './tmux-session-store.js'
import type { TmuxOrchestrator, CreateOptions } from './tmux-orchestrator.js'

let directory: string
let configPath: string
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clawx-default-agent-'))
  vi.stubEnv('XDG_CONFIG_HOME', directory)
  vi.stubEnv('CLAWX_BRAND', 'clawx')
  vi.stubEnv('CLAWX_DEFAULT_AGENT', '')
  fs.mkdirSync(path.join(directory, 'clawx'))
  configPath = path.join(directory, 'clawx', 'config.json')
})
afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('default agent configuration', () => {
  it('falls back to Claude and respects configuration, environment, then explicit selection', () => {
    expect(getDefaultAgent()).toBe('claude')
    fs.writeFileSync(configPath, JSON.stringify({ defaultAgent: 'codex' }))
    expect(getDefaultAgent()).toBe('codex')
    expect(resolveNewSessionAgent(undefined)).toBe('codex')
    expect(resolveNewSessionAgent('claude')).toBe('claude')
    vi.stubEnv('CLAWX_DEFAULT_AGENT', 'claude')
    expect(getDefaultAgent()).toBe('claude')
    expect(resolveNewSessionAgent('codex')).toBe('codex')
    expect(resolveNewSessionAgent('invalid')).toBeNull()
  })

  it('reports invalid configured defaults rather than silently choosing a backend', () => {
    fs.writeFileSync(configPath, JSON.stringify({ defaultAgent: 'invalid' }))
    expect(() => getDefaultAgent()).toThrow(/must be claude or codex/)
  })

  it('applies configuration changes to new sessions and rejects invalid API updates', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ defaultAgent: 'codex', machineName: 'keep' }))
    const store = new TmuxSessionStore({ persistPath: path.join(directory, 'tmux.json') })
    const create = vi.fn(async (opts: CreateOptions) => store.upsert({
      sessionId: opts.sessionId, tmuxName: opts.sessionId, cwd: opts.cwd,
      agentKind: opts.agentKind, createdAt: new Date().toISOString(),
    }))
    const orchestrator = { create } as unknown as TmuxOrchestrator
    const server = startWebServer({ port: 0, host: '127.0.0.1', sessionStore: new SessionStore(),
      claudeCwd: directory, mode: 'ws', instanceId: 'test', tmuxSessionStore: store,
      tmuxOrchestrator: orchestrator })
    await once(server, 'listening')
    const address = server.address() as { port: number }
    const request = (url: string, body?: object) => fetch(`http://127.0.0.1:${address.port}${url}`, {
      method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    try {
      expect((await (await request('/api/config')).json()).config.defaultAgent).toBe('codex')
      const first = await (await request('/api/tmux-sessions', { cwd: directory, sessionId: 'first', withThread: false })).json()
      expect(first.entry.agentKind).toBe('codex')
      const explicit = await (await request('/api/tmux-sessions', { cwd: directory, sessionId: 'explicit', agent: 'claude', withThread: false })).json()
      expect(explicit.entry.agentKind).toBe('claude')
      expect((await request('/api/config', { defaultAgent: 'claude' })).status).toBe(200)
      const next = await (await request('/api/tmux-sessions', { cwd: directory, sessionId: 'next', withThread: false })).json()
      expect(next.entry.agentKind).toBe('claude')
      expect(store.get('first')?.agentKind).toBe('codex')
      for (const defaultAgent of ['invalid', '', 1, null]) {
        expect((await request('/api/config', { defaultAgent })).status).toBe(400)
      }
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toMatchObject({ defaultAgent: 'claude', machineName: 'keep' })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
