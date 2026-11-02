import fs from 'node:fs'
import http from 'node:http'
import { execFileSync } from 'node:child_process'

import { defaultTmuxSessionsPath } from './tmux-session-store.js'

export async function runCodexHook(): Promise<void> {
  const ok = (): void => {
    process.stdout.write('{}\n')
  }
  let payload: any
  try {
    const stdin = await readStdin()
    payload = stdin ? JSON.parse(stdin) : null
  } catch (err) {
    process.stderr.write(`[xclaw codex-hook] failed to parse stdin: ${(err as Error).message}\n`)
    ok()
    return
  }

  const dump = process.env.CLAWX_CODEX_HOOK_DUMP?.trim()
  if (dump) {
    try {
      fs.appendFileSync(dump, JSON.stringify(payload) + '\n')
    } catch {
      /* ignore */
    }
  }

  const sessionId = pick(payload, 'session_id')
  const transcriptPath = pick(payload, 'transcript_path')
  const hookEventName = pick(payload, 'hook_event_name') ?? ''
  const prompt = pick(payload, 'prompt')
  if (!sessionId) { ok(); return }

  const clawxSessionId = resolveCodexHookSession(sessionId)
  if (!clawxSessionId) { ok(); return }

  const apiPath = hookEventName === 'UserPromptSubmit'
    ? '/api/internal/agent-turn-start'
    : hookEventName === 'Stop'
      ? '/api/internal/agent-turn-done'
      : ''
  if (!apiPath) { ok(); return }

  await postLocal(apiPath, {
    agentKind: 'codex',
    clawxSessionId,
    agentSessionId: sessionId,
    transcriptPath: transcriptPath ?? '',
    prompt: prompt ?? '',
  })
  ok()
}

export function resolveCodexHookSession(agentSessionId: string): string | null {
  const pane = process.env.TMUX_PANE
  if (!pane) return null
  try {
    const tmuxName = execFileSync('tmux', ['display-message', '-p', '-t', pane, '#{session_name}'], {
      encoding: 'utf8', timeout: 1000,
    }).trim()
    const data = JSON.parse(fs.readFileSync(defaultTmuxSessionsPath(), 'utf8')) as {
      sessions?: Array<{ sessionId: string; tmuxName: string; agentKind?: string; agentSessionId?: string }>
    }
    const entry = data.sessions?.find((s) => s.agentKind === 'codex' && s.tmuxName === tmuxName)
    if (!entry || (entry.agentSessionId && entry.agentSessionId !== agentSessionId)) return null
    return entry.sessionId
  } catch {
    return null
  }
}

function postLocal(apiPath: string, bodyObj: unknown): Promise<void> {
  const body = JSON.stringify(bodyObj)
  const port = Number(process.env.CLAWX_WEB_PORT) || 8124
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: apiPath,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        timeout: 3000,
      },
      (res) => {
        res.resume()
        res.on('end', resolve)
      },
    )
    req.on('error', () => resolve())
    req.on('timeout', () => {
      req.destroy()
      resolve()
    })
    req.write(body)
    req.end()
  })
}

function pick(obj: unknown, key: string): string | null {
  if (obj && typeof obj === 'object' && key in obj) {
    const v = (obj as Record<string, unknown>)[key]
    return typeof v === 'string' ? v : null
  }
  return null
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve('')
      return
    }
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { data += chunk })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}
