import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeAgentKind, agentDisplayName } from './agent-backend.js'
import { readAntigravityMessagesFromRaw, locateAntigravitySession } from './antigravity-sessions.js'
import { updateAntigravityHooks } from './install-antigravity-hook.js'
import { resolveAntigravityHookSession } from './antigravity-hook.js'
import { TmuxSessionStore } from './tmux-session-store.js'
import { SessionStore } from './session-store.js'
import { startWebServer } from './web.js'
import { createTmuxOrchestrator, type TmuxOrchestrator } from './tmux-orchestrator.js'

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(), execFileSync: vi.fn(),
}))
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); vi.useRealTimers() })

const timestamp = '2026-11-24T12:00:00Z'
const user = (step: number, text: string) => ({ step_index: step, type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', created_at: timestamp, content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>private metadata</ADDITIONAL_METADATA>` })
const answer = (step: number, text: string) => ({ step_index: step, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', created_at: timestamp, content: text, thinking: 'private reasoning', model: 'gemini-4-neon-high' })
const jsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n'

describe('Antigravity integration', () => {
  it('normalizes the CLI alias and keeps Claude as the legacy default', () => {
    expect(normalizeAgentKind(' AGY ')).toBe('antigravity')
    expect(agentDisplayName('antigravity')).toBe('Antigravity')
    expect(normalizeAgentKind(undefined)).toBe('claude')
    expect(normalizeAgentKind('gemini')).toBeNull()
    expect(locateAntigravitySession('../secret')).toBeNull()
  })

  it('reads actual CLI record shapes without exposing thinking, tools or injected metadata', () => {
    const parsed = readAntigravityMessagesFromRaw(jsonl([
      user(0, '检查项目'), { ...answer(1, 'partial'), status: 'ACTIVE' },
      answer(1, '完成'), { ...answer(2, 'internal'), type: 'SYSTEM_MESSAGE' },
      { ...answer(3, 'command output'), type: 'RUN_COMMAND' }, answer(1, '完成'),
    ]) + '{"incomplete":')
    expect(parsed.map((m) => m.text)).toEqual(['检查项目', '完成'])
    expect(parsed.map((m) => m.stepIndex)).toEqual([0, 1])
    expect(parsed[1]?.model).toBe('gemini-4-neon-high')
    expect(JSON.stringify(parsed)).not.toContain('private')
  })

  it('updates and removes only the owned hooks idempotently', () => {
    const other = { lint: { Stop: [{ command: 'lint' }] } }
    const next = updateAntigravityHooks(other, "'/node' '/a path/cli.js' antigravity-hook")
    expect(updateAntigravityHooks(next, "'/node' '/a path/cli.js' antigravity-hook")).toEqual(next)
    expect(updateAntigravityHooks(next)).toEqual(other)
    expect(other).not.toHaveProperty('xclaw-antigravity-sync')
  })

  it('routes by tmux pane, rejecting unrelated sessions and subagent conversation IDs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-origin-'))
    vi.stubEnv('CLAWX_DATA_DIR', dir)
    vi.stubEnv('TMUX_PANE', '%42')
    try {
      const store = new TmuxSessionStore()
      for (const id of ['first', 'live']) store.upsert({ sessionId: id, tmuxName: id, cwd: dir, agentKind: 'antigravity', createdAt: timestamp })
      vi.mocked(execFileSync).mockReturnValue('live\n')
      expect(resolveAntigravityHookSession('conversation')?.sessionId).toBe('live')
      store.patch('live', { agentSessionId: 'conversation' })
      expect(resolveAntigravityHookSession('subagent')).toBeUndefined()
      vi.stubEnv('TMUX_PANE', '')
      expect(resolveAntigravityHookSession('conversation')).toBeUndefined()
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('launches agy, accepts workspace trust, sends multiline input and interrupts with Ctrl-C', async () => {
    vi.useFakeTimers()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-launch-'))
    const store = new TmuxSessionStore({ persistPath: path.join(dir, 'sessions.json') })
    const mgr = { hasSession: vi.fn(async () => true), newSession: vi.fn(), killSession: vi.fn(),
      sendKey: vi.fn(), sendKeys: vi.fn(), setSessionOption: vi.fn(), renameWindow: vi.fn(),
      capturePane: vi.fn().mockResolvedValueOnce('Do you trust the contents of this project?').mockResolvedValue('>\n? for shortcuts    auto · Gemini 4 Neon · high'),
    }
    try {
      const orch = createTmuxOrchestrator({ store, mgr: mgr as any, antigravityCmd: '/path with spaces/agy' })
      const pending = orch.create({ sessionId: 'agy-test', cwd: dir, agentKind: 'antigravity' })
      await vi.advanceTimersByTimeAsync(2000)
      expect((await pending).agentSessionPending).toBe(true)
      expect(mgr.newSession.mock.calls[0]?.[0].cmd).toContain("exec '/path with spaces/agy' --mode accept-edits --dangerously-skip-permissions")
      expect(mgr.sendKey).toHaveBeenCalledWith(expect.objectContaining({ key: 'Enter' }))
      await orch.send('agy-test', '第一行\n第二行', 'cli')
      expect(mgr.sendKeys).toHaveBeenCalledWith(expect.objectContaining({ text: '第一行\n第二行', bracketedPaste: true }))
      await orch.interrupt('agy-test')
      expect(mgr.sendKey).toHaveBeenCalledWith(expect.objectContaining({ key: 'C-c' }))
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('delivers two turns with identical timestamps once each, excludes history on resume, and binds only the correct session', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-web-'))
    const transcript = path.join(dir, 'transcript.jsonl')
    const store = new TmuxSessionStore({ persistPath: path.join(dir, 'sessions.json') })
    store.upsert({ sessionId: 'test', tmuxName: 'test', cwd: dir, agentKind: 'antigravity', createdAt: new Date().toISOString(), lastAgentStep: 1 })
    store.upsert({ sessionId: 'other', tmuxName: 'other', cwd: dir, agentKind: 'antigravity', createdAt: timestamp })
    const cards: any[] = []
    const orchestrator = { confirmTurnStarted: vi.fn(), confirmDelivered: vi.fn(), peekSendSource: vi.fn(), identifySendSource: vi.fn() } as unknown as TmuxOrchestrator
    const server = startWebServer({ port: 0, host: '127.0.0.1', sessionStore: new SessionStore(), claudeCwd: dir,
      mode: 'ws', instanceId: 'test', tmuxSessionStore: store, tmuxOrchestrator: orchestrator,
      tmuxFanout: (payload) => { cards.push(payload) },
    })
    await once(server, 'listening')
    const { port } = server.address() as { port: number }
    const post = async (event: string, step: number, extra = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/internal/agent-turn-${event}`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentKind: 'antigravity',
          clawxSessionId: 'test', agentSessionId: 'conv', transcriptPath: transcript, turnStartStep: step, prompt: `问题${step}`, ...extra }),
      })
      expect(res.status).toBe(200)
    }
    try {
      const records = [user(0, '旧问题'), answer(1, '旧回答'), user(2, '问题2'), answer(3, '回答2')]
      fs.writeFileSync(transcript, jsonl(records))
      await post('start', 2)
      await post('start', 2)
      await post('done', 2)
      await vi.waitFor(() => expect(cards).toHaveLength(1))
      expect(orchestrator.confirmTurnStarted).toHaveBeenCalledTimes(1)
      expect(cards[0].assistantText).toBe('回答2')
      expect(cards[0].userText).toBe('问题2')
      expect(cards[0].model).toBe('gemini-4-neon-high')
      expect(store.get('other')?.agentSessionId).toBeUndefined()
      fs.appendFileSync(transcript, jsonl([user(4, '问题4'), answer(5, '回答4')]))
      await post('start', 4)
      await post('done', 4)
      await vi.waitFor(() => expect(cards).toHaveLength(2))
      await post('done', 2)
      await post('done', 4)
      await post('done', 4, { clawxSessionId: 'other' })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(cards.map((c) => c.assistantText)).toEqual(['回答2', '回答4'])
      expect(store.get('test')?.lastAgentStep).toBe(5)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
