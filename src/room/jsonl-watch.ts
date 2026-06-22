// Incrementally read Claude Code session jsonl files and extract the events
// the bridge mirrors: SendMessage tool calls (the team mailbox) and assistant
// text (used for the lead's final summary).
import fs from 'node:fs'

export interface MailboxEvent {
  kind: 'mailbox'
  from: string
  to: string
  summary: string
  body: string
}

export interface AssistantTextEvent {
  kind: 'assistant'
  from: string
  text: string
}

export type JsonlEvent = MailboxEvent | AssistantTextEvent

interface ContentBlock {
  type?: string
  name?: string
  text?: string
  input?: { to?: string; recipient?: string; summary?: string; message?: string; content?: string }
}

function blocksOf(line: string): { role: string; blocks: ContentBlock[] } | null {
  let ev: { type?: string; message?: { role?: string; content?: unknown } }
  try {
    ev = JSON.parse(line) as typeof ev
  } catch {
    return null
  }
  const msg = ev.message
  if (!msg || !Array.isArray(msg.content)) return null
  return { role: msg.role ?? ev.type ?? '', blocks: msg.content as ContentBlock[] }
}

/**
 * Read events from `file` starting at line `fromLine`.
 * Returns extracted events and the new line count (next offset).
 */
export function readNewEvents(
  file: string,
  fromLine: number,
  fromName: string,
): { events: JsonlEvent[]; lineCount: number } {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return { events: [], lineCount: fromLine }
  }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0)
  const events: JsonlEvent[] = []
  for (let i = fromLine; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    const parsed = blocksOf(line)
    if (!parsed) continue
    for (const b of parsed.blocks) {
      if (b.type === 'tool_use' && b.name === 'SendMessage') {
        const inp = b.input ?? {}
        events.push({
          kind: 'mailbox',
          from: fromName,
          to: inp.to ?? inp.recipient ?? '?',
          summary: inp.summary ?? '',
          body: inp.message ?? inp.content ?? '',
        })
      } else if (parsed.role === 'assistant' && b.type === 'text' && b.text && b.text.trim()) {
        events.push({ kind: 'assistant', from: fromName, text: b.text.trim() })
      }
    }
  }
  return { events, lineCount: lines.length }
}

/** First user-message text in a session jsonl (= teammate spawn prompt). */
export function firstUserText(file: string): string | null {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let ev: { message?: { role?: string; content?: unknown } }
    try {
      ev = JSON.parse(line) as typeof ev
    } catch {
      continue
    }
    const msg = ev.message
    if (!msg || msg.role !== 'user') continue
    if (typeof msg.content === 'string') return msg.content
    if (Array.isArray(msg.content)) {
      for (const b of msg.content as ContentBlock[]) {
        if (b.type === 'text' && b.text) return b.text
      }
    }
  }
  return null
}
