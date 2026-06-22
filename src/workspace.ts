import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { dataDir } from './config.js'

const execFileAsync = promisify(execFile)

// Per-chat workspace isolation via `git worktree`, ported from the
// Symphony / Hatice "per-issue workspace" idea.
//
// - If `baseCwd` is a git repo: each sessionId gets its own worktree
//   on a `clawx/<safe-id>` branch. Concurrent chats no longer fight
//   over the working tree.
// - If `baseCwd` is NOT a git repo: gracefully degrade — every session
//   shares `baseCwd`. This preserves behavior for users who point
//   CLAUDE_CWD at a plain directory.

export interface ResolvedWorkspace {
  cwd: string
  isolated: boolean
}

export interface WorkspaceManager {
  resolveCwd(sessionId: string): Promise<ResolvedWorkspace>
  release(sessionId: string): Promise<void>
  releaseAll(): Promise<void>
  /** Test/observability: list known workspace dirs. */
  list(): { sessionId: string; cwd: string }[]
}

export interface WorkspaceManagerOptions {
  baseCwd: string
  /** Where worktrees live. Default: ~/.local/share/clawx/workspaces */
  workspaceRoot?: string
  /** Force isolation off regardless of git status. */
  disabled?: boolean
}

export function defaultWorkspaceRoot(): string {
  return path.join(dataDir(), 'workspaces')
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', cwd, 'rev-parse', '--git-dir'], {
      timeout: 5000,
    })
    return true
  } catch {
    return false
  }
}

/** sessionId can be anything (e.g. "chat_id:email"); make it filesystem-safe. */
export function safeSessionDirName(sessionId: string): string {
  // Replace anything that isn't a sane path character. Truncate to keep
  // path lengths reasonable across filesystems.
  const cleaned = sessionId.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
  const trimmed = cleaned.length > 0 ? cleaned : 'session'
  return trimmed.slice(0, 80)
}

export async function createWorkspaceManager(
  opts: WorkspaceManagerOptions,
): Promise<WorkspaceManager> {
  const baseCwd = path.resolve(opts.baseCwd)
  const workspaceRoot = opts.workspaceRoot ?? defaultWorkspaceRoot()
  const disabled = opts.disabled === true
  const gitOk = !disabled && (await isGitRepo(baseCwd))

  // sessionId → cwd. For non-git or disabled mode, every entry maps to baseCwd.
  const map = new Map<string, string>()

  async function resolveCwd(sessionId: string): Promise<ResolvedWorkspace> {
    const cached = map.get(sessionId)
    if (cached) return { cwd: cached, isolated: gitOk }

    if (!gitOk) {
      map.set(sessionId, baseCwd)
      return { cwd: baseCwd, isolated: false }
    }

    const dirName = safeSessionDirName(sessionId)
    const target = path.join(workspaceRoot, dirName)
    const branch = `clawx/${dirName}`

    if (fs.existsSync(target)) {
      // Reuse: previous run left the worktree in place. Either we crashed
      // before release, or the caller wants to resume. Both are fine — git
      // worktree handles the bookkeeping.
      map.set(sessionId, target)
      return { cwd: target, isolated: true }
    }

    fs.mkdirSync(workspaceRoot, { recursive: true })
    try {
      // -B: reset branch if it already exists (stale from a previous worktree
      // that was rm-rf'd without `git worktree remove`). HEAD as start point
      // keeps us on whatever branch baseCwd is currently on.
      await execFileAsync('git', ['-C', baseCwd, 'worktree', 'add', '-B', branch, target, 'HEAD'], {
        timeout: 30_000,
      })
      map.set(sessionId, target)
      return { cwd: target, isolated: true }
    } catch (err) {
      // Worktree creation can fail for many reasons (locked branch, dirty
      // index, permission). Don't break the chat — degrade to baseCwd and
      // surface via logs at the call site.
      const msg = err instanceof Error ? err.message : String(err)
      const e = new Error(`worktree add failed for ${sessionId}: ${msg}`)
      ;(e as Error & { degraded?: ResolvedWorkspace }).degraded = {
        cwd: baseCwd,
        isolated: false,
      }
      throw e
    }
  }

  async function release(sessionId: string): Promise<void> {
    const dir = map.get(sessionId)
    if (!dir) return
    map.delete(sessionId)
    if (!gitOk || dir === baseCwd) return
    const dirName = path.basename(dir)
    const branch = `clawx/${dirName}`
    try {
      await execFileAsync('git', ['-C', baseCwd, 'worktree', 'remove', '--force', dir], {
        timeout: 30_000,
      })
    } catch {
      // Already gone, or never registered. Continue cleanup.
    }
    try {
      await execFileAsync('git', ['-C', baseCwd, 'branch', '-D', branch], { timeout: 10_000 })
    } catch {
      // Branch may not exist (e.g. user already deleted). Ignore.
    }
    if (fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // Best-effort: leftover files are operator-visible cleanup, not
        // a runtime error.
      }
    }
  }

  async function releaseAll(): Promise<void> {
    const ids = Array.from(map.keys())
    await Promise.all(ids.map((id) => release(id)))
  }

  function list(): { sessionId: string; cwd: string }[] {
    return Array.from(map.entries()).map(([sessionId, cwd]) => ({ sessionId, cwd }))
  }

  return { resolveCwd, release, releaseAll, list }
}
