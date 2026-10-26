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
    } }) + '\n' + record('commentary', '正在检查'))
    const store = new TmuxSessionStore({ persistPath: path.join(directory, 'tmux.json') })
    store.upsert({ sessionId: 'test', tmuxName: 'test', cwd: directory, agentKind: 'codex',
      agentSessionId: 'codex-test', transcriptPath: transcript,
      createdAt: new Date(Date.now() - 5000).toISOString() })
    const cards: any[] = []
    const orchestrator = {
      confirmTurnStarted: vi.fn(), confirmDelivered: vi.fn(),
      peekSendSource: vi.fn(), identifySendSource: vi.fn(),
    } as unknown as TmuxOrchestrator
    const server = startWebServer({ port: 0, host: '127.0.0.1', sessionStore: new SessionStore(),
      claudeCwd: directory, mode: 'ws', instanceId: 'test', tmuxSessionStore: store,
      tmuxOrchestrator: orchestrator,
      tmuxStreamBlock: ({ text }) => { cards.push(buildBotReplyCard({ text, intermediate: true })) },
      tmuxFanout: ({ assistantText }) => {
        if (assistantText) cards.push(buildBotReplyCard({ text: assistantText }))
      },
    })
    await once(server, 'listening')
    const address = server.address() as { port: number }
    const post = async (event: string) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/internal/agent-turn-${event}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentKind: 'codex', agentSessionId: 'codex-test', transcriptPath: transcript, prompt: '检查一下' }),
      })
      expect(response.status).toBe(200)
    }
    try {
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
      expect(cards[1].body.elements[0].content).toBe('检查完成')
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
