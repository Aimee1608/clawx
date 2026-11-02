import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { startWebServer } from './web.js'
import { SessionStore } from './session-store.js'
import { TmuxSessionStore } from './tmux-session-store.js'
import type { TmuxOrchestrator } from './tmux-orchestrator.js'
import { buildBotReplyCard } from './seed-text.js'
import type { AgentKind } from './agent-backend.js'

describe('reply model attribution', () => {
  it.each<AgentKind>(['claude', 'codex'])('uses the final %s response model instead of historical or later settings', async (agentKind) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawx-attribution-'))
    const transcript = path.join(dir, 'reply.jsonl')
    const now = Date.now()
    const old = new Date(now - 10000).toISOString()
    const timestamp = new Date(now - 1000).toISOString()
    const model = agentKind === 'codex' ? 'gpt-6-astra' : 'claude-opus-4-6'
    const records = agentKind === 'codex' ? [
      { type: 'turn_context', payload: { model: 'gpt-6-luna' } },
      { timestamp: old, type: 'response_item', payload: { id: 'old', type: 'message', role: 'assistant', phase: 'final_answer', content: [{ text: '旧回复' }] } },
      { timestamp, type: 'event_msg', payload: { type: 'task_started' } },
      { timestamp, type: 'turn_context', payload: { model } },
      { timestamp, type: 'response_item', payload: { id: 'user', type: 'message', role: 'user', content: [{ text: '请检查当前项目' }] } },
      { timestamp, type: 'response_item', payload: { id: 'final', type: 'message', role: 'assistant', phase: 'final_answer', content: [{ text: '最终结果' }] } },
      { timestamp, type: 'event_msg', payload: { type: 'task_complete', turn_id: 'current' } },
      { type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
    ] : [
      { timestamp, uuid: 'user', type: 'user', message: { role: 'user', content: '请检查当前项目' } },
      { timestamp: old, uuid: 'old', type: 'assistant', message: { role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: '旧回复' }], stop_reason: 'end_turn' } },
      { timestamp, uuid: 'current', type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text: '最终结果' }], stop_reason: 'end_turn' } },
    ]
    fs.writeFileSync(transcript, records.map((r) => JSON.stringify(r)).join('\n'))
    const store = new TmuxSessionStore({ persistPath: path.join(dir, 'store.json') })
    store.upsert({ sessionId: 'current', tmuxName: 'current', cwd: dir, agentKind,
      agentSessionId: 'agent-id', transcriptPath: transcript, createdAt: new Date(now - 5000).toISOString() })
    const cards: any[] = []
    const server = startWebServer({ port: 0, host: '127.0.0.1', sessionStore: new SessionStore(),
      claudeCwd: dir, mode: 'ws', instanceId: 'test', tmuxSessionStore: store,
      tmuxOrchestrator: { confirmDelivered: vi.fn(), identifySendSource: vi.fn() } as unknown as TmuxOrchestrator,
      tmuxFanout: ({ entry, assistantText, model }) => { cards.push(buildBotReplyCard({ text: assistantText!, agentKind: entry.agentKind, model, cwd: entry.cwd })) },
    })
    await once(server, 'listening')
    try {
      const { port } = server.address() as { port: number }
      await fetch(`http://127.0.0.1:${port}/api/internal/agent-turn-done`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentKind, agentSessionId: 'agent-id', transcriptPath: transcript }),
      })
      await vi.waitFor(() => expect(cards).toHaveLength(1))
      expect(cards[0].body.elements[0].content).toBe('最终结果')
      expect(cards[0].body.elements.at(-1).content).toContain(`${path.basename(dir)} ·`)
      expect(cards[0].body.elements.at(-1).content).not.toContain(dir)
      expect(cards[0].body.elements.at(-1).content).toContain(model)
      expect(cards[0].body.elements.at(-1).content).toContain(agentKind === 'codex' ? 'Codex' : 'Claude Code')
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
