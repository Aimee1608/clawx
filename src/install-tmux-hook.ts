import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Idempotently register the Stop hook in ~/.claude/settings.json so that
 * every claude turn on this machine fires `clawx tmux-hook`. The shim
 * itself does the cheap filter for whether this is actually a clawx
 * tmux session.
 *
 * `clawx install-tmux-hook`           → install
 * `clawx install-tmux-hook --remove`  → remove
 */

const HOOK_MARKER = 'clawx-tmux-hook-v1'

/** Inner command spec — what actually runs on the Stop event. */
interface HookCommand {
  type?: string
  command?: string
  // Embedded marker so re-installs recognize our own entry and rewrite
  // it instead of duplicating.
  __clawx?: string
}

/** Outer matcher group — claude's settings schema requires this wrapper
 * around the actual command spec. The matcher is unused for Stop (it
 * always fires), but the schema rejects entries without a `hooks` array. */
interface HookGroup {
  matcher?: string
  hooks?: HookCommand[]
}

interface SettingsShape {
  hooks?: {
    Stop?: HookGroup[]
    PreToolUse?: HookGroup[]
    UserPromptSubmit?: HookGroup[]
    [k: string]: HookGroup[] | undefined
  }
  [k: string]: unknown
}

/** Hook events we register the shim under.
 *   - UserPromptSubmit: fires when the user submits a prompt; we use
 *     it to post a terminal-direct echo to Lark immediately + bind a
 *     msg_id for ⏳ reactions.
 *   - Stop: fires when the main agent finishes; drives the final
 *     assistant text fanout (+ removes ⏳).
 *
 * NOTE: PreToolUse used to be registered here as a fallback path for
 * the ⏳ reaction, but UserPromptSubmit already handles ⏳ at turn
 * START — PreToolUse would short-circuit on the "already-reacted"
 * branch every time. Cost: ~200ms Node spawn per tool call × N tools
 * per turn = seconds of dead latency on tool-heavy turns. Removed.
 * The /api/internal/turn-progress endpoint stays as dead code for
 * compatibility; if anything ever resurrects PreToolUse later, the
 * server-side handler is still wired up correctly.
 *
 * Re-running `clawx install-tmux-hook` after this change clears any
 * stale PreToolUse registration from previous installs (the marker-
 * based filter below strips our own entries cleanly). */
const REGISTERED_EVENTS = ['UserPromptSubmit', 'Stop'] as const

/** Events that previous versions of clawx registered. We clean these
 * up on install so an upgrade reliably removes them from
 * ~/.claude/settings.json (otherwise the old PreToolUse entry would
 * keep firing on every tool call until the user runs --remove). */
const DEPRECATED_EVENTS = ['PreToolUse'] as const

function settingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json')
}

function readSettings(p: string): SettingsShape {
  if (!fs.existsSync(p)) return {}
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as SettingsShape
  } catch (err) {
    throw new Error(`failed to parse ${p}: ${(err as Error).message}`)
  }
}

function writeSettings(p: string, data: SettingsShape): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, p)
}

/**
 * Resolve the command string the Stop hook should execute. The hook
 * runs from claude's child shell whose PATH may not include our
 * workspace, so we MUST emit an absolute reference.
 *
 * Strategy:
 *   1. If `clawx` is on the *caller's* PATH (i.e. user did `npm i
 *      -g`), use that absolute path.
 *   2. Otherwise emit `<node> <abs-path-to-our-cli.js> tmux-hook`,
 *      using whichever node we're currently running under.
 */
function resolveHookCommand(): string {
  // 1. Reference our own cli.js by absolute path with the current
  // node executable. This is the most STABLE form — both paths point
  // at filesystem locations that survive shell lifecycle changes.
  // (Earlier versions did a PATH lookup first, but on hosts using
  // fnm with `--use-on-cd` the first match was an ephemeral path
  // under /run/user/.../fnm_multishells/ that vanishes when the
  // shell exits, silently breaking the hook later.)
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.resolve(here, 'cli.js'),
    path.resolve(here, 'cli.ts'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return `${process.execPath} ${c} tmux-hook`
    }
  }

  // 2. Fall back to a `clawx` on PATH — but reject ephemeral fnm
  // multishell shims that won't outlive this shell.
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter)
  for (const dir of pathDirs) {
    if (!dir) continue
    if (dir.includes('/fnm_multishells/')) continue // ephemeral
    const candidate = path.join(dir, 'clawx')
    try {
      const st = fs.statSync(candidate)
      if (st.isFile()) return `${candidate} tmux-hook`
    } catch {
      /* keep looking */
    }
  }

  // 3. Last resort: trust PATH lookup. Will likely fail at hook-fire
  // time but at least error visibly so the user knows to set up.
  return 'clawx tmux-hook'
}

export function runInstallTmuxHook(arg?: string): void {
  const remove = arg === '--remove' || arg === 'remove'
  const p = settingsPath()
  const settings = readSettings(p)

  // Helper: does a hook group contain our marker command?
  const isOurs = (g: HookGroup): boolean =>
    !!g.hooks?.some((c) => c.__clawx === HOOK_MARKER)

  // On both remove AND install, scrub our marker out of ALL events —
  // currently-registered ones plus historically-registered ones. This
  // is how `--remove` works AND how an upgrade installs cleanly even
  // when the previous version registered an event the new version no
  // longer wants (PreToolUse is the current example).
  const scrubEvents = [...REGISTERED_EVENTS, ...DEPRECATED_EVENTS]

  if (remove) {
    let touched = false
    for (const ev of scrubEvents) {
      const groups = settings.hooks?.[ev] ?? []
      const filtered = groups
        .map((g) => ({
          ...g,
          hooks: g.hooks?.filter((c) => c.__clawx !== HOOK_MARKER) ?? [],
        }))
        .filter((g) => g.hooks.length > 0)
      if (filtered.length !== groups.length || groups.some(isOurs)) {
        touched = true
        if (filtered.length === 0) {
          delete settings.hooks?.[ev]
        } else {
          settings.hooks = { ...(settings.hooks ?? {}), [ev]: filtered }
        }
      }
    }
    if (!touched) {
      process.stdout.write('clawx hooks not present — nothing to do.\n')
      return
    }
    writeSettings(p, settings)
    process.stdout.write(
      `Removed clawx hooks from ${p}.\n`,
    )
    return
  }

  const command = resolveHookCommand()
  const buildGroup = (): HookGroup => ({
    // Empty matcher = fire for all sessions/tools (Stop ignores matcher
    // entirely; PreToolUse uses it for tool-name regex but we want all).
    matcher: '',
    hooks: [
      {
        type: 'command',
        command,
        __clawx: HOOK_MARKER,
      },
    ],
  })

  // Step 1: install the current set.
  for (const ev of REGISTERED_EVENTS) {
    const existing = settings.hooks?.[ev] ?? []
    const others = existing
      .map((g) => ({
        ...g,
        hooks: g.hooks?.filter((c) => c.__clawx !== HOOK_MARKER) ?? [],
      }))
      .filter((g) => g.hooks.length > 0)
    settings.hooks = { ...(settings.hooks ?? {}), [ev]: [...others, buildGroup()] }
  }
  // Step 2: scrub any leftover registrations under DEPRECATED_EVENTS
  // (e.g. PreToolUse from a pre-optimization clawx install).
  for (const ev of DEPRECATED_EVENTS) {
    const existing = settings.hooks?.[ev] ?? []
    if (existing.length === 0) continue
    const filtered = existing
      .map((g) => ({
        ...g,
        hooks: g.hooks?.filter((c) => c.__clawx !== HOOK_MARKER) ?? [],
      }))
      .filter((g) => g.hooks.length > 0)
    if (filtered.length === 0) {
      delete settings.hooks?.[ev]
    } else {
      settings.hooks = { ...(settings.hooks ?? {}), [ev]: filtered }
    }
  }
  writeSettings(p, settings)

  process.stdout.write(
    [
      `✓ Installed clawx ${REGISTERED_EVENTS.join(' + ')} hooks → ${p}`,
      `  command: ${command}`,
      '',
      'UserPromptSubmit fires when the user submits a prompt — adds the',
      '⏳ reaction and (for terminal-direct input) echoes the prompt into',
      'the Lark thread. Stop fires after each assistant turn — removes ⏳',
      'and posts the final assistant text. Both shims are no-ops for',
      'non-clawx tmux sessions.',
      '',
      'PreToolUse hook was REMOVED to eliminate per-tool-call Node fork',
      'overhead. ⏳ already lands at UserPromptSubmit; PreToolUse was a',
      'never-needed fallback. If you upgraded from a prior clawx, the',
      'stale registration was scrubbed automatically.',
      '',
      'To remove: `clawx install-tmux-hook --remove`',
      '',
    ].join('\n'),
  )
}
