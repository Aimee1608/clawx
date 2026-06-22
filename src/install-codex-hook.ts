import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOOK_MARKER = 'clawx-codex-hook-v1'
const EVENTS = ['UserPromptSubmit', 'Stop'] as const

interface HookCommand {
  type?: string
  command?: string
  timeout?: number
  statusMessage?: string
  __clawx?: string
}
interface HookGroup { matcher?: string; hooks?: HookCommand[] }
interface HooksFile { hooks?: Record<string, HookGroup[]>; [k: string]: unknown }

function hooksPath(): string {
  const base = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex')
  return path.join(base, 'hooks.json')
}

function readHooks(p: string): HooksFile {
  if (!fs.existsSync(p)) return {}
  return JSON.parse(fs.readFileSync(p, 'utf8')) as HooksFile
}

function writeHooks(p: string, data: HooksFile): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, p)
}

function resolveHookCommand(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const c of [path.resolve(here, 'cli.js'), path.resolve(here, 'cli.ts')]) {
    if (fs.existsSync(c)) return `${process.execPath} ${c} codex-hook`
  }
  return 'clawx codex-hook'
}

export function runInstallCodexHook(arg?: string): void {
  const remove = arg === '--remove' || arg === 'remove'
  const p = hooksPath()
  const doc = readHooks(p)
  const hooks = { ...(doc.hooks ?? {}) }

  for (const ev of EVENTS) {
    const groups = hooks[ev] ?? []
    const cleaned = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => h.__clawx !== HOOK_MARKER) }))
      .filter((g) => (g.hooks ?? []).length > 0)
    if (cleaned.length > 0) hooks[ev] = cleaned
    else delete hooks[ev]
  }

  if (!remove) {
    const command = resolveHookCommand()
    for (const ev of EVENTS) {
      const group: HookGroup = {
        matcher: '',
        hooks: [{ type: 'command', command, timeout: 10, statusMessage: 'clawx codex sync', __clawx: HOOK_MARKER }],
      }
      hooks[ev] = [...(hooks[ev] ?? []), group]
    }
  }

  doc.hooks = hooks
  writeHooks(p, doc)
  if (remove) {
    process.stdout.write(`Removed clawx Codex hooks from ${p}.\n`)
  } else {
    process.stdout.write(
      [
        `✓ Installed clawx Codex UserPromptSubmit + Stop hooks → ${p}`,
        `  command: ${resolveHookCommand()}`,
        '',
        'Codex requires non-managed hooks to be trusted. If prompted in the TUI,',
        'open /hooks and trust the clawx-codex-hook entries. clawx tmux',
        '--agent codex also launches with --dangerously-bypass-hook-trust so',
        'trusted dev-box automation can run without an invisible prompt.',
        '',
        'To remove: `clawx install-codex-hook --remove`',
        '',
      ].join('\n'),
    )
  }
}
