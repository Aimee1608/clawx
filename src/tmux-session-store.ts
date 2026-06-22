import fs from 'node:fs'
import path from 'node:path'

import type { AgentKind } from './agent-backend.js'
import { dataDir } from './config.js'

/**
 * Persistent map: clawx session-id ↔ tmux session metadata.
 *
 * Why a separate store from src/session-store.ts? That one is keyed by
 * the Hub/WS sessionId (chat-level) and points at a single claude UUID
 * for resume semantics. tmux sessions have a different lifecycle:
 *   - one tmux per logical conversation, long-lived across restarts
 *   - one claude UUID per tmux (the REPL pid encodes it, but the
 *     transcript jsonl records it too)
 *   - optional Lark thread_id for Phase 2 routing
 *
 * Keeping these in a separate file:
 *   1. Lets us atomically rewrite without touching the existing
 *      sessions.json that production code reads on every poll
 *   2. Makes "list all tmux sessions" cheap (one file scan)
 *   3. Easy to wipe ("rm ~/.local/share/clawx/tmux-sessions.json")
 *      when iterating early in the feature
 */

export interface TmuxSessionEntry {
  /** clawx session id (chat:oc_xxx in WS mode, or arbitrary in Hub). */
  sessionId: string
  /** tmux session name we spawned (safe-charset slug). */
  tmuxName: string
  /** cwd handed to the tmux session at creation. */
  cwd: string
  /** Agent running inside the tmux pane. Missing means legacy Claude. */
  agentKind?: AgentKind
  /** Generic agent session id. For Claude this equals `claudeUuid`; for
   * Codex this is `session_meta.payload.id` from ~/.codex/sessions. */
  agentSessionId?: string
  /** Transcript jsonl path when known. Codex uses this heavily because
   * its session files are date-sharded rather than cwd-sharded. */
  transcriptPath?: string
  /** True while a newly-started backend hasn't written its session id yet. */
  agentSessionPending?: boolean
  /** Claude session UUID inside the REPL. Discovered from jsonl after
   * the first turn (because claude REPL allocates it lazily); may be
   * empty until Stop-hook reports it the first time. */
  claudeUuid?: string
  /** Optional Lark thread id. Set when phase 2 is wired up. */
  threadId?: string
  /** Optional Lark chat id (the group hosting the thread). */
  chatId?: string
  /** Optional Lark message id of the seed message that anchors the
   * thread. Required by im.message.reply when posting follow-ups. */
  rootMessageId?: string
  /** ISO timestamp of creation. */
  createdAt: string
  /** ISO timestamp of last Stop-hook fire we processed. */
  lastTurnAt?: string
  /** Free-form label the user can override (used in UI titles). */
  label?: string
  /** Lark message_id of the user input that opened the CURRENT
   * in-flight turn. Set on send (for web/cli/lark inputs) and used
   * by the PreToolUse-driven progress indicator to attach an emoji
   * reaction. Cleared at turn-done. Transient — survival across
   * daemon restarts isn't important. */
  currentTurnUserMessageId?: string
  /** reaction_id returned by Lark when we ⏳-reacted to
   * currentTurnUserMessageId. Used to remove the reaction at
   * turn-done. */
  currentTurnReactionId?: string
}

export interface TmuxSessionStoreOptions {
  /** Override the persistence path (mainly for tests). */
  persistPath?: string
}

export function defaultTmuxSessionsPath(): string {
  return path.join(dataDir(), 'tmux-sessions.json')
}

interface DiskShape {
  version: 1
  sessions: TmuxSessionEntry[]
}

const EMPTY: DiskShape = { version: 1, sessions: [] }

export class TmuxSessionStore {
  private readonly persistPath: string
  private byId: Map<string, TmuxSessionEntry> = new Map()
  private byTmuxName: Map<string, TmuxSessionEntry> = new Map()
  private byClaudeUuid: Map<string, TmuxSessionEntry> = new Map()
  private byAgentSession: Map<string, TmuxSessionEntry> = new Map()
  private byThreadId: Map<string, TmuxSessionEntry> = new Map()

  constructor(opts: TmuxSessionStoreOptions = {}) {
    this.persistPath = opts.persistPath ?? defaultTmuxSessionsPath()
    this.load()
  }

  private load(): void {
    try {
      if (fs.existsSync(this.persistPath)) {
        const raw = fs.readFileSync(this.persistPath, 'utf8')
        const data = JSON.parse(raw) as DiskShape
        if (data && Array.isArray(data.sessions)) {
          for (const e of data.sessions) this.indexInsert(normalizeEntry(e))
        }
      }
    } catch {
      // Corrupt file → start fresh; flush will overwrite on next change.
    }
  }

  private indexInsert(e: TmuxSessionEntry): void {
    this.byId.set(e.sessionId, e)
    this.byTmuxName.set(e.tmuxName, e)
    if (e.claudeUuid) this.byClaudeUuid.set(e.claudeUuid, e)
    const kind = e.agentKind ?? 'claude'
    const agentSessionId = e.agentSessionId ?? (kind === 'claude' ? e.claudeUuid : undefined)
    if (agentSessionId) this.byAgentSession.set(agentKey(kind, agentSessionId), e)
    if (e.threadId) this.byThreadId.set(e.threadId, e)
  }

  private indexRemove(e: TmuxSessionEntry): void {
    this.byId.delete(e.sessionId)
    this.byTmuxName.delete(e.tmuxName)
    if (e.claudeUuid) this.byClaudeUuid.delete(e.claudeUuid)
    const kind = e.agentKind ?? 'claude'
    const agentSessionId = e.agentSessionId ?? (kind === 'claude' ? e.claudeUuid : undefined)
    if (agentSessionId) this.byAgentSession.delete(agentKey(kind, agentSessionId))
    if (e.threadId) this.byThreadId.delete(e.threadId)
  }

  private flush(): void {
    const data: DiskShape = {
      version: 1,
      sessions: Array.from(this.byId.values()),
    }
    fs.mkdirSync(path.dirname(this.persistPath), { recursive: true })
    const tmp = `${this.persistPath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.persistPath)
  }

  upsert(entry: TmuxSessionEntry): TmuxSessionEntry {
    entry = normalizeEntry(entry)
    const existing = this.byId.get(entry.sessionId)
    if (existing) this.indexRemove(existing)
    this.indexInsert(entry)
    this.flush()
    return entry
  }

  /** Patch fields of an existing entry. Throws when sessionId not found. */
  patch(sessionId: string, patch: Partial<TmuxSessionEntry>): TmuxSessionEntry {
    const cur = this.byId.get(sessionId)
    if (!cur) throw new Error(`tmux session not found: ${sessionId}`)
    const merged: TmuxSessionEntry = normalizeEntry({ ...cur, ...patch, sessionId: cur.sessionId })
    this.indexRemove(cur)
    this.indexInsert(merged)
    this.flush()
    return merged
  }

  get(sessionId: string): TmuxSessionEntry | undefined {
    return this.byId.get(sessionId)
  }

  getByTmuxName(name: string): TmuxSessionEntry | undefined {
    return this.byTmuxName.get(name)
  }

  getByClaudeUuid(uuid: string): TmuxSessionEntry | undefined {
    return this.byClaudeUuid.get(uuid)
  }

  getByAgentSession(kind: AgentKind, sessionId: string): TmuxSessionEntry | undefined {
    return this.byAgentSession.get(agentKey(kind, sessionId))
  }

  getByThreadId(threadId: string): TmuxSessionEntry | undefined {
    return this.byThreadId.get(threadId)
  }

  entries(): TmuxSessionEntry[] {
    return Array.from(this.byId.values())
  }

  remove(sessionId: string): boolean {
    const existing = this.byId.get(sessionId)
    if (!existing) return false
    this.indexRemove(existing)
    this.flush()
    return true
  }

  /** Test / dev convenience: drop everything. */
  clear(): void {
    this.byId.clear()
    this.byTmuxName.clear()
    this.byClaudeUuid.clear()
    this.byAgentSession.clear()
    this.byThreadId.clear()
    this.flush()
  }
}

function agentKey(kind: AgentKind, sessionId: string): string {
  return `${kind}:${sessionId}`
}

function normalizeEntry(e: TmuxSessionEntry): TmuxSessionEntry {
  const agentKind = e.agentKind ?? 'claude'
  const agentSessionId = e.agentSessionId ?? (agentKind === 'claude' ? e.claudeUuid : undefined)
  return {
    ...e,
    agentKind,
    agentSessionId,
    claudeUuid: e.claudeUuid ?? (agentKind === 'claude' ? agentSessionId : undefined),
    agentSessionPending: e.agentSessionPending ?? !agentSessionId,
  }
}
