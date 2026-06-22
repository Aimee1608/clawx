import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { dataDir } from './config.js'

/**
 * Persistent state for the DM agent: the single Claude UUID we
 * `--resume` for every DM so the conversation context survives
 * across turns and across daemon restarts.
 *
 * On first DM ever, we allocate a new uuid and pass it via
 * `--session-id` so the first claude --print run anchors a fresh
 * session at that uuid. Subsequent DMs use `--resume <uuid>` to
 * continue.
 *
 * Path: $XDG_DATA_HOME (or ~/.local/share)/clawx/agent-state.json
 * Atomic write: tmp + rename.
 */

export interface AgentState {
  version: 1
  agentClaudeUuid: string
  /** Optional: cwd to spawn claude in. Defaults to CLAUDE_CWD env. The
   * agent doesn't really need a meaningful cwd — its job is ops, not
   * code work — but claude needs SOMETHING. */
  cwd?: string
  createdAt: string
}

function defaultPath(): string {
  return path.join(dataDir(), 'agent-state.json')
}

let cached: AgentState | null = null

export function loadAgentState(): AgentState {
  if (cached) return cached
  const p = defaultPath()
  if (fs.existsSync(p)) {
    try {
      const raw = fs.readFileSync(p, 'utf8')
      const parsed = JSON.parse(raw) as AgentState
      if (parsed && parsed.agentClaudeUuid) {
        cached = parsed
        return parsed
      }
    } catch {
      /* fall through to fresh allocation */
    }
  }
  // Fresh state. Save immediately so subsequent calls + a restart see
  // the same uuid (otherwise we'd lose context on every restart).
  const state: AgentState = {
    version: 1,
    agentClaudeUuid: randomUUID(),
    createdAt: new Date().toISOString(),
  }
  saveAgentState(state)
  return state
}

export function saveAgentState(state: AgentState): void {
  const p = defaultPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, p)
  cached = state
}

/** Mainly for tests / `clawx agent reset` (if we ever add it). */
export function resetAgentState(): void {
  const p = defaultPath()
  try {
    fs.unlinkSync(p)
  } catch {
    /* ignore */
  }
  cached = null
}
