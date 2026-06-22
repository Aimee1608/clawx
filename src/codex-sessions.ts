import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { UiMessage } from './claude-sessions.js'

export interface CodexSessionMeta {
  id: string
  path: string
  cwd?: string
  createdAt?: string
  lastModified: string
  sizeBytes: number
}

export function codexSessionsRoot(): string {
  return path.join(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex'), 'sessions')
}

function walkJsonl(root: string): string[] {
  const out: string[] = []
  function walk(dir: string): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p)
    }
  }
  if (fs.existsSync(root)) walk(root)
  return out
}

function readSessionMeta(filePath: string): { id?: string; cwd?: string; createdAt?: string } {
  let head = ''
  try {
    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(64 * 1024)
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      head = buf.subarray(0, n).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return {}
  }
  for (const line of head.split('\n')) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line) as any
      if (rec?.type === 'session_meta' && rec.payload && typeof rec.payload === 'object') {
        return {
          id: typeof rec.payload.id === 'string' ? rec.payload.id : undefined,
          cwd: typeof rec.payload.cwd === 'string' ? rec.payload.cwd : undefined,
          createdAt: typeof rec.payload.timestamp === 'string' ? rec.payload.timestamp : undefined,
        }
      }
    } catch {
      /* skip */
    }
  }
  return {}
}

export function scanAllCodexSessions(): CodexSessionMeta[] {
  const out: CodexSessionMeta[] = []
  for (const file of walkJsonl(codexSessionsRoot())) {
    let st: fs.Stats
    try {
      st = fs.statSync(file)
    } catch {
      continue
    }
    const meta = readSessionMeta(file)
    if (!meta.id) continue
    out.push({
      id: meta.id,
      path: file,
      cwd: meta.cwd,
      createdAt: meta.createdAt,
      lastModified: st.mtime.toISOString(),
      sizeBytes: st.size,
    })
  }
  out.sort((a, b) => b.lastModified.localeCompare(a.lastModified))
  return out
}

export function locateCodexSession(id: string): { jsonlPath: string; cwd?: string } | null {
  for (const s of scanAllCodexSessions()) {
    if (s.id === id) return { jsonlPath: s.path, cwd: s.cwd }
  }
  return null
}

export function readMessagesByCodexSessionId(
  id: string,
): { messages: UiMessage[]; path: string; lastModifiedMs: number } | null {
  const located = locateCodexSession(id)
  if (!located) return null
  try {
    const st = fs.statSync(located.jsonlPath)
    return {
      messages: readCodexMessages(fs.readFileSync(located.jsonlPath, 'utf8')),
      path: located.jsonlPath,
      lastModifiedMs: st.mtimeMs,
    }
  } catch {
    return null
  }
}

export function findNewestCodexSessionForCwd(args: {
  cwd: string
  afterMs?: number
}): CodexSessionMeta | null {
  const resolved = resolveReal(args.cwd)
  const afterMs = args.afterMs ?? 0
  const matches = scanAllCodexSessions().filter((s) => {
    if (!s.cwd) return false
    if (resolveReal(s.cwd) !== resolved) return false
    const mtime = Date.parse(s.lastModified) || 0
    const created = s.createdAt ? Date.parse(s.createdAt) || 0 : 0
    if (created) return created + 2000 >= afterMs
    return mtime + 2000 >= afterMs
  })
  return matches[0] ?? null
}

export async function waitForNewestCodexSessionForCwd(args: {
  cwd: string
  afterMs?: number
  timeoutMs?: number
  intervalMs?: number
}): Promise<CodexSessionMeta | null> {
  const deadline = Date.now() + (args.timeoutMs ?? 15_000)
  const intervalMs = args.intervalMs ?? 500
  while (Date.now() < deadline) {
    const found = findNewestCodexSessionForCwd({ cwd: args.cwd, afterMs: args.afterMs })
    if (found) return found
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return findNewestCodexSessionForCwd({ cwd: args.cwd, afterMs: args.afterMs })
}

function resolveReal(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

function extractCodexText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    if (typeof b.text === 'string') parts.push(b.text)
    else if (typeof b.content === 'string') parts.push(b.content)
  }
  return parts.join('\n')
}

export function readCodexMessages(raw: string): UiMessage[] {
  return readCodexMessagesFromRaw(raw).messages
}

export function readCodexMessagesFromRaw(raw: string): {
  messages: UiMessage[]
  completedTurnIds: Set<string>
} {
  const out: UiMessage[] = []
  const seen = new Set<string>()
  const completedTurnIds = new Set<string>()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let rec: any
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (rec.type === 'event_msg' && rec.payload?.type) {
      const typ = String(rec.payload.type)
      if (/task_(complete|completed|stopped|finished)|turn_(complete|completed|stopped|finished)/i.test(typ)) {
        const turnId = typeof rec.payload.turn_id === 'string' ? rec.payload.turn_id : 'unknown'
        completedTurnIds.add(turnId)
      }
    }
    if (rec.type !== 'response_item') continue
    const p = rec.payload
    if (!p || p.type !== 'message') continue
    if (p.role !== 'user' && p.role !== 'assistant') continue
    const text = extractCodexText(p.content)
    if (!text.trim()) continue
    const uuid = String(p.id ?? `${rec.timestamp ?? ''}:${out.length}`)
    if (seen.has(uuid)) continue
    seen.add(uuid)
    out.push({
      role: p.role,
      text,
      timestamp: String(rec.timestamp ?? ''),
      uuid,
      stopReason: p.role === 'assistant' ? 'end_turn' : undefined,
    })
  }
  return { messages: out, completedTurnIds }
}
