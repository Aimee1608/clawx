import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { startWebServer } from './web.js'
import { SessionStore } from './session-store.js'
import { TmuxSessionStore } from './tmux-session-store.js'
import type { TmuxOrchestrator } from './tmux-orchestrator.js'
import { readAntigravityMessagesFromRaw } from './antigravity-sessions.js'

const timestamp = '2026-11-25T09:00:00Z'
const record = (step: number, type: string, content: string, extra = {}) => ({
  step_index: step, type, content, source: type === 'USER_INPUT' ? 'USER_EXPLICIT' : 'MODEL',
  status: 'DONE', created_at: timestamp, ...extra,
})
const user = (step: number) => record(step, 'USER_INPUT', `问题${step}`)
const answer = (step: number, text: string) => record(step, 'PLANNER_RESPONSE', text, { thinking: 'hidden reasoning' })
const tool = (step: number) => record(step, 'GENERIC', 'private command output', { status: 'RUNNING' })
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
afterEach(() => vi.unstubAllEnvs())

async function setup(onProgress?: (text: string) => Promise<void>) {
  vi.stubEnv('CLAWX_STREAM_REPLIES', '1')
  vi.stubEnv('CLAWX_STREAM_POLL_MS', '200')
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-stream-'))
  const transcript = path.join(cwd, 'transcript.jsonl')
  const store = new TmuxSessionStore({ persistPath: path.join(cwd, 'sessions.json') })
  store.upsert({ sessionId: 'test', tmuxName: 'test', cwd, agentKind: 'antigravity',
    agentSessionId: 'agy-test', createdAt: new Date().toISOString(), lastAgentStep: 1 })
  const progress: string[] = []
  const finals: string[] = []
  const server = startWebServer({ port: 0, host: '127.0.0.1', sessionStore: new SessionStore(),
    claudeCwd: cwd, mode: 'ws', instanceId: 'test', tmuxSessionStore: store,
    tmuxOrchestrator: { confirmTurnStarted: vi.fn(), confirmDelivered: vi.fn(), peekSendSource: vi.fn(), identifySendSource: vi.fn() } as unknown as TmuxOrchestrator,
    tmuxStreamBlock: async ({ text }) => { await onProgress?.(text); progress.push(text) },
    tmuxFanout: ({ assistantText }) => { if (assistantText) finals.push(assistantText) },
  })
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  return { transcript, progress, finals, store,
    post: async (event: string, step: number) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/internal/agent-turn-${event}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentKind: 'antigravity', agentSessionId: 'agy-test', clawxSessionId: 'test',
          transcriptPath: transcript, prompt: `问题${step}`, turnStartStep: step }),
      })
      expect(response.status).toBe(200)
    },
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(cwd, { recursive: true, force: true }) },
  }
}

it.each([true, false])('delivers current-turn progress and finals once, with equal timestamps and resumed history (poll=%s)', async (polling) => {
  const app = await setup()
  let rows = [user(0), answer(1, '旧答案'), user(2), answer(3, '正在检查'), tool(4)]
  fs.writeFileSync(app.transcript, jsonl(rows))
  try {
    if (polling) {
      await app.post('start', 2)
      await vi.waitFor(() => expect(app.progress).toEqual(['正在检查']))
      expect(app.finals).toEqual([])
      await app.post('start', 2)
    }
    rows.push(answer(5, '第一轮完成'), user(6), answer(7, '第二轮完成'))
    fs.writeFileSync(app.transcript, jsonl(rows))
    await app.post('done', 2)
    await vi.waitFor(() => expect(app.finals).toEqual(['第一轮完成']))
    expect(app.progress).toEqual(['正在检查'])
    await app.post('done', 2)
    await app.post('start', 6)
    await app.post('done', 6)
    await vi.waitFor(() => expect(app.finals).toEqual(['第一轮完成', '第二轮完成']))
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(app.progress).toEqual(['正在检查'])
    expect(app.store.get('test')?.lastAgentStep).toBe(7)
  } finally { await app.close() }
})

it('detects equal-size rewrites, keeps the final back, and retries a failed progress post', async () => {
  let calls = 0
  const app = await setup(async () => { if (++calls === 1) throw new Error('transient post failure') })
  const initial = jsonl([user(2), answer(3, '正在检查'), record(4, 'SYSTEM_MESSAGE', 'internal metadata', { source: 'SYSTEM' })])
  const updated = jsonl([user(2), answer(3, '正在检查'), tool(4)])
  const length = Math.max(Buffer.byteLength(initial), Buffer.byteLength(updated))
  const pad = (s: string) => s + ' '.repeat(length - Buffer.byteLength(s))
  fs.writeFileSync(app.transcript, pad(initial))
  try {
    await app.post('start', 2)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(app.progress).toEqual([])
    fs.writeFileSync(app.transcript, pad(updated))
    fs.utimesSync(app.transcript, new Date(), new Date(Date.now() + 1000))
    await vi.waitFor(() => expect(app.progress).toEqual(['正在检查']), { timeout: 2000 })
    expect(calls).toBe(2)
    fs.writeFileSync(app.transcript, updated + jsonl([answer(5, '最终答案')]))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(app.progress).toEqual(['正在检查'])
    expect(app.finals).toEqual([])
    await app.post('done', 2)
    await vi.waitFor(() => expect(app.finals).toEqual(['最终答案']))
  } finally { await app.close() }
})

it('waits for an in-flight progress post before final delivery', async () => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  const posting = vi.fn(() => pending)
  const app = await setup(posting)
  fs.writeFileSync(app.transcript, jsonl([user(2), answer(3, '正在检查'), tool(4)]))
  try {
    await app.post('start', 2)
    await vi.waitFor(() => expect(posting).toHaveBeenCalledOnce())
    fs.appendFileSync(app.transcript, jsonl([answer(5, '最终答案')]))
    await app.post('done', 2)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(app.finals).toEqual([])
    release()
    await vi.waitFor(() => expect(app.finals).toEqual(['最终答案']))
    expect(app.progress).toEqual(['正在检查'])
  } finally { release(); await app.close() }
})

it('marks text followed by tool-only planner steps as commentary without leaking internal fields', () => {
  const parsed = readAntigravityMessagesFromRaw(jsonl([user(0), answer(1, '检查中'),
    record(2, 'PLANNER_RESPONSE', '', { tool_calls: [{ name: 'run_command', args: 'private command' }], thinking: 'secret' }),
    tool(3), answer(4, '完成'), user(5), answer(6, '下一轮'),
  ]))
  expect(parsed.map((m) => [m.text, m.phase])).toEqual([
    ['问题0', undefined], ['检查中', 'commentary'], ['完成', undefined], ['问题5', undefined], ['下一轮', undefined],
  ])
  expect(JSON.stringify(parsed)).not.toMatch(/private|hidden|secret/)
})
