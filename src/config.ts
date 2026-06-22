import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * After the tmux-only refactor, the only config layer left is the
 * user-config JSON. Each entry point (ws-main for now) reads it
 * directly and applies its own env/CLI override priority. This file
 * just defines the JSON shape and provides the reader.
 *
 * Env-vars consumed in the runtime (not parsed here, just listed for
 * the operator's reference):
 *
 *   CLAUDE_CMD                       (default: 'claude')
 *   CLAUDE_CWD                       (override of cwd)
 *   CLAUDE_TIMEOUT_MS                (idle, default 300_000 — see agent-runner.ts)
 *   CLAUDE_FIRST_BYTE_TIMEOUT_MS     (default 1_800_000)
 *   CLAUDE_HARD_TIMEOUT_MS           (default 1_800_000)
 *   LARK_APP_ID / LARK_APP_SECRET    (required for WS mode)
 *   CLAWX_TMUX_THREAD_CHAT_ID      (group chat_id for /new-tmux)
 *   CLAWX_WEB_PORT / CLAWX_WEB_HOST
 *   CLAWX_PROXY_URL                (mihomo override; default http://127.0.0.1:7890)
 *   CLAWX_DISABLE_PROXY_INJECT     ('1' = skip the proxy normalizer)
 */

/** Shape of `~/.config/clawx/config.json`. All fields optional. */
export interface UserConfigFile {
  claudeCwd?: string
  claudeCmd?: string
  codexCmd?: string
  claudeTimeoutMs?: number
  claudeHardTimeoutMs?: number
  maxQueueSize?: number
  machineName?: string
  larkAppId?: string
  larkAppSecret?: string
  /** Lark chat_id of the group where tmux-mode session threads are
   * created. Each new tmux session gets its own thread in this group.
   * Env override: CLAWX_TMUX_THREAD_CHAT_ID. */
  tmuxThreadChatId?: string
  /** Named extra topic groups for `clawx tmux --group <name>`, so
   * non-dev sessions can land in a separate Lark group. `tmuxThreadChatId`
   * stays the DEFAULT (used when no --group is passed). Each value is a
   * group chat_id the bot has been added to.
   * Example: { "dev": "oc_aaa", "life": "oc_bbb" }. */
  tmuxThreadChats?: Record<string, string>
  /** Curated list of cwds that show up FIRST in the Tmux create
   * picker. Operator edits manually OR via the picker's pin button.
   * Paths may begin with `~/` — expanded to $HOME at read time. */
  tmuxCwdFavorites?: string[]
  /** Directories whose immediate children show up as "workspace
   * 项目" suggestions in the picker. Defaults to
   * `[~/workspace]`. Paths may begin with `~/`. */
  tmuxCwdScanRoots?: string[]
  /** Lark reaction emoji_type used by the PreToolUse-driven progress
   * indicator. Defaults to "HOURGLASS"; if your Lark workspace rejects
   * it, try "DAIBAN" (待办) or "OK" — list of valid types is published
   * at the Lark Open Platform reactions API docs. */
  tmuxProgressEmoji?: string
  /** Operator's own Lark open_id (`ou_...`). When set, seed messages
   * @-mention this user so they auto-subscribe to the new topic and
   * receive push notifications. Auto-discovered + persisted on first
   * inbound DM, so most operators don't need to set this by hand. */
  userOpenId?: string
}

/** Instance brand. A throwaway instance (CLAWX_BRAND=clawx) gets fully
 * isolated config/data/tmux from the real `clawx`; unset = 'clawx'.
 * Restricted charset so it stays a safe path/tmux segment. */
export function brand(): string {
  const b = process.env.CLAWX_BRAND?.trim()
  return b && /^[a-z0-9_-]+$/i.test(b) ? b : 'clawx'
}

/** Per-user config root: $XDG_CONFIG_HOME/<brand> or ~/.config/<brand>. */
export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), '.config')
  return path.join(base, brand())
}

/** Per-user data root: $CLAWX_DATA_DIR or ~/.local/share/<brand>. */
export function dataDir(): string {
  const explicit = process.env.CLAWX_DATA_DIR?.trim()
  if (explicit && explicit.length > 0) return explicit
  const xdg = process.env.XDG_DATA_HOME?.trim()
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), '.local', 'share')
  return path.join(base, brand())
}

function userConfigPath(): string {
  return path.join(configDir(), 'config.json')
}

export function loadUserConfigFile(): UserConfigFile {
  const p = userConfigPath()
  if (!fs.existsSync(p)) return {}
  try {
    const raw = fs.readFileSync(p, 'utf8')
    const parsed = JSON.parse(raw) as UserConfigFile
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    // Corrupt user config should not crash startup; callers see env/defaults.
    return {}
  }
}

/** Atomically rewrite the user config file. tmp + rename so concurrent
 * readers always see a complete document. */
function writeUserConfigFile(data: UserConfigFile): void {
  const p = userConfigPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, p)
}

/** Append a cwd to `tmuxCwdFavorites` (idempotent — no-op if already
 * present). Returns the resulting favorites list. */
export function addCwdFavorite(cwd: string): string[] {
  const cfg = loadUserConfigFile()
  const list = cfg.tmuxCwdFavorites ?? []
  if (list.includes(cwd)) return list
  const next = [...list, cwd]
  writeUserConfigFile({ ...cfg, tmuxCwdFavorites: next })
  return next
}

/** Remove a cwd from `tmuxCwdFavorites`. Returns the resulting list. */
export function removeCwdFavorite(cwd: string): string[] {
  const cfg = loadUserConfigFile()
  const list = cfg.tmuxCwdFavorites ?? []
  const next = list.filter((p) => p !== cwd)
  if (next.length === list.length) return list
  writeUserConfigFile({ ...cfg, tmuxCwdFavorites: next })
  return next
}

/** Persist the operator's own Lark open_id. Called by ws-main the
 * first time an inbound DM arrives — subsequent thread creations can
 * then @-mention this user so they auto-subscribe to the new topic.
 * Idempotent: returns false when the value is unchanged. */
export function setUserOpenId(openId: string): boolean {
  if (!openId.trim()) return false
  const cfg = loadUserConfigFile()
  if (cfg.userOpenId === openId) return false
  writeUserConfigFile({ ...cfg, userOpenId: openId })
  return true
}

/** Expand a leading `~/` against the current user's home dir. */
export function expandHomePath(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}
