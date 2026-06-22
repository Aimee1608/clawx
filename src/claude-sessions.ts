import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── Types ────────────────────────────────────────────────────────

export interface ClaudeSessionMeta {
  uuid: string
  projectDir: string
  /** Absolute cwd extracted from first jsonl line, if present. */
  cwd?: string
  /** Claude CLI entrypoint that wrote this session: 'sdk-cli' (our bot
   * + programmatic), 'cli' (interactive claude), 'vscode', etc. */
  entrypoint?: string
  /** First non-empty user turn text, capped to ~80 chars. */
  firstPrompt?: string
  /** ISO timestamp from first jsonl line. */
  firstTs?: string
  /** mtime of the jsonl file — "last turn" approximation. */
  lastModified: string
  sizeBytes: number
}

export interface UiMessage {
  role: 'user' | 'assistant'
  text: string
  timestamp: string
  /** jsonl-internal uuid for de-dup / debugging */
  uuid: string
  /** true if this turn was a synthetic error (auth failure etc.) */
  isError?: boolean
  /** assistant-only: claude's stop_reason (`end_turn`, `tool_use`,
   * `stop_sequence`, `max_tokens`). Used by the turn-done retry loop
   * to detect "is the response complete on disk yet" without a second
   * file read. */
  stopReason?: string
}

/**
 * State classification for a session — used by the manager skill to decide
 * whether this conversation needs human attention.
 *
 * - `waiting_for_user`: assistant produced an end-of-turn reply, no user
 *    follow-up since. Most common "needs attention" state.
 * - `working`: last line is a tool_use, tool_result, or user turn that
 *    hasn't been answered yet — claude is mid-thinking. Don't bother the human.
 * - `errored`: last assistant turn was a synthetic API error (auth, 403,
 *    etc.) or structured error record. Needs attention.
 * - `idle`: session file exists but we can't tell what state it's in (no
 *    parseable last line, empty, etc.).
 */
export type SessionState = 'waiting_for_user' | 'working' | 'errored' | 'idle'

// ── Path resolution ──────────────────────────────────────────────

export function claudeProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects')
}

/**
 * Claude CLI realpath-resolves the cwd (so `/home/x/ws` vs the
 * symlink-resolved variant land in the same project dir), then
 * replaces every non-alphanumeric char with `-`. Example:
 *   /home/alice/workspace → -home-alice-workspace
 */
export function encodeCwdForClaude(cwd: string): string {
  let resolved = cwd
  try {
    resolved = fs.realpathSync(cwd)
  } catch {
    resolved = path.resolve(cwd)
  }
  return resolved.replace(/[^A-Za-z0-9]/g, '-')
}

export function resolveClaudeJsonl(cwd: string, uuid: string): string {
  return path.join(claudeProjectsRoot(), encodeCwdForClaude(cwd), `${uuid}.jsonl`)
}

// ── Content parsing ──────────────────────────────────────────────

export function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: string; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n')
}

/** Parse all user+assistant text turns from a claude jsonl file. */
export function readClaudeMessages(jsonlPath: string): UiMessage[] {
  return readClaudeMessagesFromRaw(fs.readFileSync(jsonlPath, 'utf8'))
}

/** Single-pass scan of an already-loaded jsonl string. Lets callers
 * derive `messages` + raw-line signals (e.g. "is there an end_turn
 * after sinceMs") from one file read — important because the file is
 * being actively appended to and two separate reads can disagree by a
 * line, producing torn views in the turn-done retry loop. */
export function readClaudeMessagesFromRaw(raw: string): UiMessage[] {
  const out: UiMessage[] = []
  const seen = new Set<string>()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let rec: any
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    const ts = String(rec.timestamp ?? '')
    const uuid = String(rec.uuid ?? '')
    if (uuid && seen.has(uuid)) continue

    if (rec.type === 'user' && rec.message?.role === 'user') {
      const c = rec.message.content
      const text = typeof c === 'string' ? c : extractText(c)
      if (text.trim()) {
        out.push({ role: 'user', text, timestamp: ts, uuid })
        if (uuid) seen.add(uuid)
      }
    } else if (rec.type === 'assistant' && rec.message?.role === 'assistant') {
      const text = extractText(rec.message.content)
      if (text.trim()) {
        out.push({
          role: 'assistant',
          text,
          timestamp: ts,
          uuid,
          isError: rec.isApiErrorMessage === true || rec.error === 'authentication_failed',
          stopReason: typeof rec.message.stop_reason === 'string' ? rec.message.stop_reason : undefined,
        })
        if (uuid) seen.add(uuid)
      }
    }
  }
  return out
}

/** Last N parsed turns of a session, oldest-first. */
export function tailClaudeMessages(jsonlPath: string, n: number): UiMessage[] {
  const all = readClaudeMessages(jsonlPath)
  return all.slice(-n)
}

// ── Scan-on-disk ─────────────────────────────────────────────────

function readJsonlHead(filePath: string, bytes = 8192): {
  firstRecord: any | null
  firstUserPrompt: string | null
  entrypoint: string | null
  cwd: string | null
} {
  let head = ''
  try {
    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(bytes)
      const n = fs.readSync(fd, buf, 0, bytes, 0)
      head = buf.subarray(0, n).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return { firstRecord: null, firstUserPrompt: null, entrypoint: null, cwd: null }
  }
  let firstRecord: any = null
  let firstUserPrompt: string | null = null
  let entrypoint: string | null = null
  let cwd: string | null = null
  for (const line of head.split('\n')) {
    if (!line.trim()) continue
    let rec: any
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (!firstRecord) firstRecord = rec
    if (!entrypoint && typeof rec.entrypoint === 'string') entrypoint = rec.entrypoint
    if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd
    if (!firstUserPrompt && rec.type === 'user' && rec.message?.role === 'user') {
      const c = rec.message.content
      const t = typeof c === 'string' ? c : extractText(c)
      if (t.trim()) firstUserPrompt = t.trim().slice(0, 80)
    }
    if (firstUserPrompt && entrypoint && cwd) break
  }
  return { firstRecord, firstUserPrompt, entrypoint, cwd }
}

export function scanAllClaudeSessions(): ClaudeSessionMeta[] {
  const root = claudeProjectsRoot()
  if (!fs.existsSync(root)) return []
  const out: ClaudeSessionMeta[] = []
  let projectDirs: string[] = []
  try {
    projectDirs = fs.readdirSync(root)
  } catch {
    return []
  }
  for (const proj of projectDirs) {
    const projAbs = path.join(root, proj)
    let files: string[] = []
    try {
      const entries = fs.readdirSync(projAbs)
      files = entries.filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const file of files) {
      const abs = path.join(projAbs, file)
      let st: fs.Stats
      try {
        st = fs.statSync(abs)
      } catch {
        continue
      }
      const uuid = file.replace(/\.jsonl$/, '')
      const head = readJsonlHead(abs)
      const firstTs = head.firstRecord?.timestamp
      out.push({
        uuid,
        projectDir: proj,
        cwd: head.cwd ?? undefined,
        entrypoint: head.entrypoint ?? undefined,
        firstPrompt: head.firstUserPrompt ?? undefined,
        firstTs: typeof firstTs === 'string' ? firstTs : undefined,
        lastModified: st.mtime.toISOString(),
        sizeBytes: st.size,
      })
    }
  }
  // Most-recently-modified first — matches what users expect of a
  // "recent sessions" dashboard.
  out.sort((a, b) => b.lastModified.localeCompare(a.lastModified))
  return out
}

export function readMessagesByUuidFromProjects(
  uuid: string,
): { messages: UiMessage[]; path: string; lastModifiedMs: number } | null {
  const root = claudeProjectsRoot()
  if (!fs.existsSync(root)) return null
  for (const proj of fs.readdirSync(root)) {
    const candidate = path.join(root, proj, `${uuid}.jsonl`)
    if (fs.existsSync(candidate)) {
      const lastModifiedMs = fs.statSync(candidate).mtimeMs
      return { messages: readClaudeMessages(candidate), path: candidate, lastModifiedMs }
    }
  }
  return null
}

// ── State classification ─────────────────────────────────────────

/**
 * Tail-scan the last ~4KB of a jsonl file and classify the session's
 * current state. Cheap enough to run on every session during a periodic
 * sweep (millisecond-range per file even for multi-MB logs because we
 * only touch the last chunk).
 */
export function classifySessionStateFromFile(jsonlPath: string): {
  state: SessionState
  lastAssistantText?: string
  lastAssistantTs?: string
} {
  let tail = ''
  try {
    const st = fs.statSync(jsonlPath)
    if (st.size === 0) return { state: 'idle' }
    const fd = fs.openSync(jsonlPath, 'r')
    try {
      const readBytes = Math.min(st.size, 8192)
      const buf = Buffer.alloc(readBytes)
      fs.readSync(fd, buf, 0, readBytes, Math.max(0, st.size - readBytes))
      tail = buf.subarray(0, readBytes).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return { state: 'idle' }
  }

  // Walk lines from end → front, looking for the last non-empty parseable
  // record. We care about: type, message.role, message.content, error flags,
  // and the final assistant stop_reason (if present).
  const lines = tail.split('\n').filter((l) => l.trim())
  let lastAssistantText: string | undefined
  let lastAssistantTs: string | undefined
  let finalType: string | undefined
  let finalStopReason: string | undefined
  let finalIsError = false

  for (let i = lines.length - 1; i >= 0; i--) {
    let rec: any
    try {
      rec = JSON.parse(lines[i]!)
    } catch {
      continue
    }
    // Claude Code CLI appends control records (e.g. `type: "last-prompt"`)
    // after each turn. They aren't part of the conversation, so they must
    // not influence the state machine — only canonical message types do.
    const recType = typeof rec.type === 'string' ? rec.type : undefined
    const isCanonical =
      recType === 'assistant' || recType === 'user' || recType === 'tool_result'
    if (!finalType && isCanonical) {
      finalType = recType
      finalIsError = rec.isApiErrorMessage === true || rec.error === 'authentication_failed' || !!rec.isApiErrorMessage
      finalStopReason = rec.message?.stop_reason ?? rec.stop_reason
    }
    if (!lastAssistantText && recType === 'assistant' && rec.message?.role === 'assistant') {
      const t = extractText(rec.message.content)
      if (t.trim()) {
        lastAssistantText = t.trim()
        lastAssistantTs = typeof rec.timestamp === 'string' ? rec.timestamp : undefined
      }
    }
    if (finalType && lastAssistantText) break
  }

  if (!finalType) return { state: 'idle' }

  if (finalIsError) {
    return { state: 'errored', lastAssistantText, lastAssistantTs }
  }

  // Final record is assistant with end_turn (or unspecified but present) →
  // the conversation is paused, waiting on the next user input.
  if (finalType === 'assistant') {
    if (!finalStopReason || finalStopReason === 'end_turn' || finalStopReason === 'stop_sequence') {
      return { state: 'waiting_for_user', lastAssistantText, lastAssistantTs }
    }
    // `tool_use` stop_reason: assistant wants to run a tool, waiting on
    // tool result. Still "working", not waiting-for-user.
    return { state: 'working', lastAssistantText, lastAssistantTs }
  }

  // User / tool_result at the end → claude hasn't responded yet → working.
  if (finalType === 'user' || finalType === 'tool_result') {
    return { state: 'working', lastAssistantText, lastAssistantTs }
  }

  return { state: 'idle', lastAssistantText, lastAssistantTs }
}

/** Classify by uuid, scanning all project dirs to find the file. */
export function classifySessionStateByUuid(uuid: string): {
  state: SessionState
  lastAssistantText?: string
  lastAssistantTs?: string
  jsonlPath?: string
} | null {
  const located = locateSession(uuid)
  if (!located) return null
  return { ...classifySessionStateFromFile(located.jsonlPath), jsonlPath: located.jsonlPath }
}

/**
 * Locate a session's jsonl on disk by uuid (across all project dirs) and
 * lift the original `cwd` from the first parseable record in the file.
 * The cwd is needed when spawning `claude --resume <uuid>` so claude lands
 * in the same project dir it was originally started in.
 */
export function locateSession(uuid: string): { jsonlPath: string; cwd?: string } | null {
  const root = claudeProjectsRoot()
  if (!fs.existsSync(root)) return null
  for (const proj of fs.readdirSync(root)) {
    const candidate = path.join(root, proj, `${uuid}.jsonl`)
    if (fs.existsSync(candidate)) {
      const head = readJsonlHead(candidate)
      return { jsonlPath: candidate, cwd: head.cwd ?? undefined }
    }
  }
  return null
}
