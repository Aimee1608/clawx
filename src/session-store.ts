import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { dataDir } from './config.js'

export interface SessionEntry {
  sessionId: string
  claudeUuid: string
  createdAt: number
  messageCount: number
  lastUsedAt: number
  /**
   * Directory the claude subprocess runs in for this session. Today this
   * always equals `config.claudeCwd` — one bot, one cwd. Stored per-entry
   * so the UI can surface it without threading config through every read,
   * and so future "per-session cwd" (one bot handling multiple workspaces)
   * can be added without schema migration.
   */
  cwd?: string
}

export interface SessionStoreOptions {
  /**
   * Path to a JSON file used to persist `sessionId → claudeUuid` mappings
   * across process restarts. Absent / empty → pure in-memory (used by
   * e2e tests to avoid cross-test pollution).
   *
   * File format: `{ "version": 1, "entries": SessionEntry[] }`.
   */
  persistPath?: string

  /**
   * Current-process cwd. When loading an older persisted file whose entries
   * predate the `cwd` field, this value is used to backfill them so the UI
   * shows a real path immediately instead of em-dash.
   */
  defaultCwd?: string
}

const FILE_VERSION = 1

/**
 * Maps Hub's `session_id` (e.g. "chat_id:email") to Claude CLI's `--session-id` UUID.
 *
 * - First message in a new session → mint a fresh UUID, `isNew=true` (no `--resume`).
 * - Subsequent messages → return the same UUID with `isNew=false` (pass `--resume`).
 * - `/new` → mark a session for rotation; next message generates a fresh UUID.
 *
 * Persistence (opt-in via `SessionStoreOptions.persistPath`): every mutation
 * that changes the core map (`getOrCreateClaudeUuid`, `markNewForNext` when it
 * deletes, `clear`) writes the new state to disk atomically (tmp + rename).
 * Read happens once at construction. `rotateOnNext` is intentionally NOT
 * persisted — a `/new` followed by a process restart before the next message
 * is rare, and a resumed session after such a restart is harmless (the user's
 * next message just reuses the old uuid instead of starting fresh).
 */
export class SessionStore {
  private map = new Map<string, SessionEntry>()
  private rotateOnNext = new Set<string>()
  private readonly persistPath: string | undefined
  private readonly defaultCwd: string | undefined

  constructor(opts: SessionStoreOptions = {}) {
    const p = opts.persistPath?.trim()
    this.persistPath = p && p.length > 0 ? p : undefined
    this.defaultCwd = opts.defaultCwd?.trim() || undefined
    if (this.persistPath) this.loadFromDisk()
  }

  getOrCreateClaudeUuid(sessionId: string, cwd?: string): { uuid: string; isNew: boolean } {
    if (this.rotateOnNext.has(sessionId)) {
      this.rotateOnNext.delete(sessionId)
      this.map.delete(sessionId)
    }
    let entry = this.map.get(sessionId)
    let isNew = false
    if (!entry) {
      entry = {
        sessionId,
        claudeUuid: randomUUID(),
        createdAt: Date.now(),
        messageCount: 0,
        lastUsedAt: Date.now(),
        cwd,
      }
      this.map.set(sessionId, entry)
      isNew = true
    } else if (cwd && !entry.cwd) {
      // Backfill cwd on pre-existing entries loaded from older persisted state.
      entry.cwd = cwd
    }
    entry.messageCount += 1
    entry.lastUsedAt = Date.now()
    this.flushToDisk()
    return { uuid: entry.claudeUuid, isNew }
  }

  /**
   * Rebind a chat's sessionId to an explicit existing claude UUID. Used by
   * `/resume <uuid>` so the next message resumes that claude session
   * instead of the one currently bound. The next dispatch will see
   * `isNew=false` and pass `--resume <uuid>` to claude.
   *
   * Clears any pending `markNewForNext` flag for the same sessionId since
   * an explicit rebind supersedes a queued "rotate to new".
   */
  setClaudeUuid(sessionId: string, claudeUuid: string, cwd?: string): void {
    this.rotateOnNext.delete(sessionId)
    const existing = this.map.get(sessionId)
    this.map.set(sessionId, {
      sessionId,
      claudeUuid,
      createdAt: existing?.createdAt ?? Date.now(),
      messageCount: existing?.messageCount ?? 0,
      lastUsedAt: Date.now(),
      cwd: cwd ?? existing?.cwd ?? this.defaultCwd,
    })
    this.flushToDisk()
  }

  /**
   * Mark a session (or all sessions) so the next message opens a fresh Claude session.
   * Called by `/new` meta command.
   */
  markNewForNext(sessionId?: string): void {
    if (sessionId) {
      this.rotateOnNext.add(sessionId)
      return
    }
    for (const key of this.map.keys()) {
      this.rotateOnNext.add(key)
    }
  }

  get(sessionId: string): SessionEntry | undefined {
    return this.map.get(sessionId)
  }

  entries(): SessionEntry[] {
    return Array.from(this.map.values())
  }

  clear(): void {
    this.map.clear()
    this.rotateOnNext.clear()
    this.flushToDisk()
  }

  size(): number {
    return this.map.size
  }

  // ── Persistence ──────────────────────────────────────────────────

  private loadFromDisk(): void {
    const p = this.persistPath
    if (!p) return
    if (!fs.existsSync(p)) return
    try {
      const raw = fs.readFileSync(p, 'utf8')
      const parsed = JSON.parse(raw) as { version?: number; entries?: SessionEntry[] }
      if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.entries)) return
      for (const e of parsed.entries) {
        if (e && typeof e.sessionId === 'string' && typeof e.claudeUuid === 'string') {
          this.map.set(e.sessionId, {
            sessionId: e.sessionId,
            claudeUuid: e.claudeUuid,
            createdAt: Number(e.createdAt) || Date.now(),
            messageCount: Number(e.messageCount) || 0,
            lastUsedAt: Number(e.lastUsedAt) || Date.now(),
            // Backfill cwd on entries persisted before the field existed.
            cwd: typeof e.cwd === 'string' ? e.cwd : this.defaultCwd,
          })
        }
      }
    } catch {
      // Corrupt file: fall back to empty state rather than crash. A doctor
      // check surfaces the broken file; a next write overwrites it clean.
    }
  }

  private flushToDisk(): void {
    const p = this.persistPath
    if (!p) return
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      const payload = JSON.stringify(
        { version: FILE_VERSION, entries: Array.from(this.map.values()) },
        null,
        2,
      )
      // Atomic: write to sibling .tmp then rename. Rename on the same
      // filesystem is atomic, so partial writes never surface if the
      // process dies mid-flush.
      const tmp = `${p}.${process.pid}.tmp`
      fs.writeFileSync(tmp, payload, { mode: 0o600 })
      fs.renameSync(tmp, p)
    } catch {
      // Swallow: session persistence is a best-effort convenience, must
      // never break the dispatch path. Disk full / permission denied will
      // leave the in-memory state unsaved; next write attempt may succeed.
    }
  }
}

/** Default persistence path: `$XDG_DATA_HOME/clawx/sessions.json`
 * or `~/.local/share/clawx/sessions.json`. */
export function defaultSessionsPath(): string {
  return path.join(dataDir(), 'sessions.json')
}
