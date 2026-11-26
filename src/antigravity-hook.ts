import fs from 'node:fs'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { defaultTmuxSessionsPath, type TmuxSessionEntry } from './tmux-session-store.js'
import { readAntigravityMessagesFromRaw } from './antigravity-sessions.js'

export function resolveAntigravityHookSession(id: string): TmuxSessionEntry | undefined {
  if (!process.env.TMUX_PANE) return undefined
  try {
    const name = execFileSync('tmux', ['display-message', '-p', '-t', process.env.TMUX_PANE, '#{session_name}'], {
      encoding: 'utf8', timeout: 1000,
    }).trim()
    const data = JSON.parse(fs.readFileSync(defaultTmuxSessionsPath(), 'utf8')) as { sessions?: TmuxSessionEntry[] }
    return data.sessions?.find((s) => s.agentKind === 'antigravity' && s.tmuxName === name && (!s.agentSessionId || s.agentSessionId === id))
  } catch { return undefined }
}

export async function runAntigravityHook(): Promise<void> {
  let result: Record<string, unknown> = {}
  try {
    let raw = ''
    for await (const chunk of process.stdin) raw += chunk
    const payload = JSON.parse(raw)
    const id = payload.conversationId
    const event = payload.hookEventName
    if (typeof id !== 'string') return
    const entry = resolveAntigravityHookSession(id)
    if (!entry) return
    if (event === 'PreToolUse' && payload.toolCall?.name === 'ask_question') {
      result = { decision: 'deny', reason: '用户通过飞书回复，请直接用普通文本提出问题并结束当前回合，等待用户文字回复。' }
      return
    }
    const start = event === 'PreInvocation' && payload.invocationNum === 0
    const done = event === 'Stop' && payload.fullyIdle === true && payload.continuationActive !== true
    if (!start && !done) return
    const transcriptPath = typeof payload.transcriptPath === 'string' ? payload.transcriptPath : ''
    let turnStartStep: number | undefined
    try {
      const messages = readAntigravityMessagesFromRaw(fs.readFileSync(transcriptPath, 'utf8'))
      turnStartStep = messages.filter((m) => m.role === 'user').at(-1)?.stepIndex
    } catch {}
    await postLocal(start ? '/api/internal/agent-turn-start' : '/api/internal/agent-turn-done', {
      agentKind: 'antigravity', clawxSessionId: entry.sessionId, agentSessionId: id, transcriptPath,
      prompt: typeof payload.lastUserInput === 'string' ? payload.lastUserInput : '', turnStartStep,
      error: typeof payload.error === 'string' ? payload.error : undefined,
    })
  } catch (error) {
    process.stderr.write(`[xclaw antigravity-hook] ${(error as Error).message}\n`)
  } finally {
    process.stdout.write(JSON.stringify(result) + '\n')
  }
}

async function postLocal(apiPath: string, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload)
  for (let attempt = 0; attempt < 3; attempt++) {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: Number(process.env.CLAWX_WEB_PORT) || 8124,
        path: apiPath, method: 'POST', timeout: 1500,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode === 200))
        res.on('error', () => resolve(false))
      })
      req.on('error', () => resolve(false))
      req.on('timeout', () => { req.destroy(); resolve(false) })
      req.end(body)
    })
    if (ok) return
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 300))
  }
  process.stderr.write('[xclaw antigravity-hook] daemon callback failed\n')
}
