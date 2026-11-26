import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { UiMessage } from './claude-sessions.js'

export interface AntigravityMessage extends UiMessage {
  stepIndex: number
}

export function locateAntigravitySession(id: string): { jsonlPath: string } | null {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) return null
  const root = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs')
  for (const name of ['transcript_full.jsonl', 'transcript.jsonl']) {
    const jsonlPath = path.join(root, name)
    if (fs.existsSync(jsonlPath)) return { jsonlPath }
  }
  return null
}

export function readAntigravityMessagesFromRaw(raw: string): AntigravityMessage[] {
  const records = new Map<number, Record<string, unknown>>()
  for (const line of raw.split('\n')) {
    let record: Record<string, unknown>
    try { record = JSON.parse(line) } catch { continue }
    if (!record || !Number.isSafeInteger(record.step_index) || (record.step_index as number) < 0) continue
    records.set(record.step_index as number, record)
  }
  const messages: AntigravityMessage[] = []
  let hasLaterModelStep = false
  for (const [stepIndex, record] of [...records].sort((a, b) => b[0] - a[0])) {
    const user = record.type === 'USER_INPUT' && record.source === 'USER_EXPLICIT'
    if (user) hasLaterModelStep = false
    const commentary = hasLaterModelStep || (Array.isArray(record.tool_calls) && record.tool_calls.length > 0)
    if (record.source === 'MODEL' && ['PLANNER_RESPONSE', 'GENERIC', 'ERROR_MESSAGE'].includes(String(record.type))) hasLaterModelStep = true
    if (record.status !== 'DONE' || typeof record.content !== 'string' || typeof record.created_at !== 'string') continue
    if (!user && record.type !== 'PLANNER_RESPONSE' && record.type !== 'ERROR_MESSAGE') continue
    const text = user ? (record.content.match(/^<USER_REQUEST>\s*\n([\s\S]*?)\n<\/USER_REQUEST>/)?.[1] ?? record.content) : record.content
    if (!text.trim()) continue
    messages.push({
      stepIndex, uuid: `antigravity:${stepIndex}`, role: user ? 'user' : 'assistant', text,
      timestamp: record.created_at,
      model: typeof record.model === 'string' ? record.model : undefined,
      isError: record.type === 'ERROR_MESSAGE',
      phase: !user && commentary && record.type !== 'ERROR_MESSAGE' ? 'commentary' : undefined,
    })
  }
  return messages.reverse()
}

export function readMessagesByAntigravitySessionId(id: string) {
  const located = locateAntigravitySession(id)
  if (!located) return null
  try {
    return { messages: readAntigravityMessagesFromRaw(fs.readFileSync(located.jsonlPath, 'utf8')),
      path: located.jsonlPath, lastModifiedMs: fs.statSync(located.jsonlPath).mtimeMs }
  } catch { return null }
}
