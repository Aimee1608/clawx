import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startWebServer } from './web.js'
import { SessionStore } from './session-store.js'
import { TmuxSessionStore } from './tmux-session-store.js'
import type { TmuxOrchestrator } from './tmux-orchestrator.js'
import { buildBotReplyCard } from './seed-text.js'

afterEach(() => vi.unstubAllEnvs())

describe('Codex thread reply delivery', () => {
  it.each([true, false])('sends commentary in turquoise and the final once (polling=%s)', async (polling) => {
    vi.stubEnv('CLAWX_STREAM_REPLIES', '1')
    vi.stubEnv('CLAWX_STREAM_POLL_MS', '200')
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clawx-codex-stream-'))
    const transcript = path.join(directory, 'session.jsonl')
    const timestamp = new Date(Date.now() - 1000).toISOString()
    const record = (phase: string, text: string) => JSON.stringify({ timestamp,
      type: 'response_item', payload: { id: phase, type: 'message', role: 'assistant',
        phase, content: [{ type: 'output_text', text }] } }) + '\n'
    fs.writeFileSync(transcript, JSON.stringify({ timestamp, type: 'response_item', payload: {
      id: 'user', type: 'message', role: 'user', content: [{ text: '检查一下' }],
    } }) + '\n' + JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }) + '\n' + record('commentary', '正在检查'))
    const store = new TmuxSessionStore({ persistPath: path.join(directory, 'tmux.json') })
    store.upsert({ sessionId: 'dead-first', tmuxName: 'dead-first', cwd: directory, agentKind: 'codex',
      agentSessionPending: true, createdAt: new Date(Date.now() - 15000).toISOString() })
    store.upsert({ sessionId: 'test', tmuxName: 'test', cwd: directory, agentKind: 'codex',
      agentSessionPending: true,
      createdAt: new Date(Date.now() - 5000).toISOString() })
    store.upsert({ sessionId: 'dead', tmuxName: 'dead', cwd: directory, agentKind: 'codex',
      agentSessionPending: true, createdAt: new Date(Date.now() - 10000).toISOString() })
    const cards: any[] = []
    const orchestrator = {
      confirmTurnStarted: vi.fn(), confirmDelivered: vi.fn(),
      peekSendSource: vi.fn(), identifySendSource: vi.fn(),
    } as unknown as TmuxOrchestrator
    const server = startWebServer({ port: 0, host: '127.0.0.1', sessionStore: new SessionStore(),
      claudeCwd: directory, mode: 'ws', instanceId: 'test', tmuxSessionStore: store,
      tmuxOrchestrator: orchestrator,
      tmuxStreamBlock: ({ entry, text }) => { expect(entry.sessionId).toBe('test'); cards.push(buildBotReplyCard({ text, intermediate: true })) },
      tmuxFanout: ({ entry, assistantText, model }) => {
        expect(entry.sessionId).toBe('test')
        if (assistantText) cards.push(buildBotReplyCard({ text: assistantText, agentKind: entry.agentKind, model, cwd: entry.cwd }))
      },
    })
    await once(server, 'listening')
    const address = server.address() as { port: number }
    const post = async (event: string) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/internal/agent-turn-${event}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentKind: 'codex', clawxSessionId: 'test', agentSessionId: 'codex-test', transcriptPath: transcript, prompt: '检查一下' }),
      })
      expect(response.status).toBe(200)
    }
    try {
      for (const clawxSessionId of [undefined, 'missing']) {
        await fetch(`http://127.0.0.1:${address.port}/api/internal/agent-turn-start`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentKind: 'codex', agentSessionId: 'codex-test',
            transcriptPath: transcript, clawxSessionId, prompt: '检查一下' }),
        })
      }
      expect(store.get('test')?.agentSessionId).toBeUndefined()
      expect(store.get('dead-first')?.agentSessionId).toBeUndefined()
      expect(orchestrator.confirmTurnStarted).not.toHaveBeenCalled()
      if (polling) {
        await post('start')
        await vi.waitFor(() => expect(cards).toHaveLength(1), { timeout: 2000 })
        expect(cards[0].header.template).toBe('turquoise')
        expect(store.get('test')?.lastTurnAt).toBeUndefined()
      }
      fs.appendFileSync(transcript, record('final_answer', '检查完成') + JSON.stringify({
        timestamp: new Date().toISOString(), type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn-test' },
      }) + '\n')
      await post('done')
      await vi.waitFor(() => expect(cards).toHaveLength(2), { timeout: 2000 })
      expect(cards.map((card) => card.header.template)).toEqual(['turquoise', 'blue'])
      expect(cards[0].body.elements).toHaveLength(1)
      expect(cards[1].body.elements[0].content).toBe('检查完成')
      expect(cards[1].body.elements.at(-1).content).toContain(`${path.basename(directory)} · Codex · gpt-6.1-sol`)
      expect(store.get('test')?.agentSessionId).toBe('codex-test')
      expect(store.get('dead')?.agentSessionId).toBeUndefined()
      await fetch(`http://127.0.0.1:${address.port}/api/internal/agent-turn-start`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentKind: 'codex', agentSessionId: 'codex-test',
          clawxSessionId: 'dead-first', prompt: 'wrong origin' }),
      })
      expect(store.get('dead-first')?.agentSessionId).toBeUndefined()
      await post('done')
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(cards).toHaveLength(2)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
