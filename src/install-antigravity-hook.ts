import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MARKER = 'xclaw-antigravity-sync'
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`

export function updateAntigravityHooks(doc: Record<string, unknown>, command?: string): Record<string, unknown> {
  const next = { ...doc }
  delete next[MARKER]
  if (command) {
    const handler = { type: 'command', command, timeout: 10 }
    next[MARKER] = {
      PreInvocation: [handler], Stop: [handler],
      PreToolUse: [{ matcher: '^ask_question$', hooks: [handler] }],
    }
  }
  return next
}

export function runInstallAntigravityHook(arg?: string): void {
  const remove = arg === '--remove' || arg === 'remove'
  const file = path.join(os.homedir(), '.gemini', 'config', 'hooks.json')
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js')
  if (!remove && !fs.existsSync(cli)) throw new Error('请先 pnpm build，再安装 Antigravity hook')
  const command = `${quote(process.execPath)} ${quote(cli)} antigravity-hook`
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  const doc = old ? JSON.parse(old) : {}
  if (!doc || Array.isArray(doc) || typeof doc !== 'object') throw new Error('Antigravity hooks.json 必须为对象')
  const next = JSON.stringify(updateAntigravityHooks(doc, remove ? undefined : command), null, 2) + '\n'
  if (next !== old) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (old !== null) fs.writeFileSync(`${file}.xclaw-backup-${Date.now()}`, old, { mode: 0o600 })
    fs.writeFileSync(`${file}.tmp`, next, { mode: 0o600 })
    fs.renameSync(`${file}.tmp`, file)
  }
  process.stdout.write(`${remove ? 'Removed' : 'Installed'} xclaw Antigravity hooks → ${file}\n`)
}
