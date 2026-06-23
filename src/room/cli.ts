// `clawx room` subcommand — multi-agent room (Agent Teams + Feishu topic
// bridge). Self-parses its own argv slice so it stays independent of the
// main CLI's option schema. Entry: runRoomCli(argv).
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { launchRoom, killRoom } from './launcher.js'
import { runBridge, releaseBridgeLock } from './bridge.js'
import { listRooms, loadRoom, updateRoom, roomDir, readBridgeLockPid } from './room-store.js'
import { loadTemplate, listTemplates } from './templates.js'
import { loadLarkApps, resolveGroupChat, LarkFleet } from './lark-multi.js'
import { runRoomInit } from './room-init.js'

interface ParsedArgs {
  opts: Record<string, string>
  positionals: string[]
}

function parseArgs(argv: string[]): ParsedArgs {
  const opts: Record<string, string> = {}
  const positionals: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a) continue
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const val = argv[i + 1]
      if (val !== undefined && !val.startsWith('--')) {
        opts[key] = val
        i++
      } else {
        opts[key] = 'true'
      }
    } else {
      positionals.push(a)
    }
  }
  return { opts, positionals }
}

const ROOM_SUBS = new Set(['init', 'ls', 'kill', 'prune', 'bridge', 'attach', 'revive', 'templates', 'help'])

const ROOM_USAGE = [
  'clawx room — 多 agent 房间(Agent Teams + 飞书话题桥):',
  '  clawx room [cwd] --label "标题" [--template <名>] [--brief "议题全文" | --brief-file <f>] [--group <群名> | --chat <oc_...>]',
  '                              --template/--tpl 选场景模板(不给用 design);--group 选注册过的话题群',
  '                              建房 → 桥转后台 → 直接 attach 进 tmux(Ctrl-b d 退出,房间照跑)',
  '  clawx room init           交互配置多 bot fleet(校验 token + 探 open_id → lark-apps.json)',
  '  clawx room templates      列出可用模板(项目 .forge/templates + 全局 + 内置)',
  '  clawx room attach <rid>   重新进入某房间的 tmux(顺带确保桥活着)',
  '  clawx room revive         确保所有活房间的桥都在后台跑(幂等,可重复执行)',
  '  clawx room ls             列房间(● live / ✗ gone)',
  '  clawx room kill <rid>     杀房间(tmux + 桥)',
  '  clawx room prune          清理已结束/已死的房间',
  '  clawx room bridge <rid>   前台跑桥(仅调试;有桥在跑会自动退出,不会双开)',
].join('\n')

/** Resolve the main `clawx` CLI entry + how to spawn it, from this
 * module's own location. dist/room/cli.js → dist/cli.js (node); under tsx,
 * src/room/cli.ts → src/cli.ts via the tsx binary. */
function mainCliLaunch(roomId: string): string[] {
  const here = fileURLToPath(import.meta.url)
  const viaDist = here.includes(`${path.sep}dist${path.sep}`)
  const repoRoot = path.resolve(path.dirname(here), '..', '..')
  if (viaDist) {
    return [path.join(repoRoot, 'dist', 'cli.js'), 'room', 'bridge', roomId]
  }
  return [
    path.join(repoRoot, 'node_modules', '.bin', 'tsx'),
    path.join(repoRoot, 'src', 'cli.ts'),
    'room',
    'bridge',
    roomId,
  ]
}

/** Ensure ONE detached background bridge per room. Idempotent: checks the
 * recorded pid and the lock file here, and the bridge itself self-locks on
 * startup — so any launch path (CLI, scripts, repeat calls) is safe. */
async function ensureBridge(roomId: string): Promise<void> {
  const room = loadRoom(roomId)
  if (!room) throw new Error(`room ${roomId} not found`)
  for (const pid of [room.bridgePid, readBridgeLockPid(roomId)]) {
    if (!pid) continue
    try {
      process.kill(pid, 0)
      return // a bridge is alive — nothing to do
    } catch {
      /* dead — keep checking, then respawn */
    }
  }
  const logFd = fs.openSync(path.join(roomDir(roomId), 'bridge.log'), 'a')
  const child = spawn(process.execPath, mainCliLaunch(roomId), {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  })
  child.unref()
  await updateRoom(roomId, (r) => ({ ...r, bridgePid: child.pid }))
}

async function tmuxAlive(session: string): Promise<boolean> {
  try {
    await promisify(execFile)('tmux', ['has-session', '-t', session])
    return true
  } catch {
    return false
  }
}

/** Detach summary — when you Ctrl-b d out of a room's tmux, the shell
 * scrollback ends with WHAT you left + HOW to re-attach / list / kill /
 * prune. Mirrors the single-agent (solo) detach summary. */
function printDetachSummary(room: { id: string; label?: string; cwd: string; threadId?: string }): void {
  console.log('')
  console.log(`✓ 已退出围观「${room.label || room.id}」— 房间在后台照跑(桥没停)`)
  console.log(`  rid:      ${room.id}`)
  console.log(`  cwd:      ${room.cwd}`)
  if (room.threadId) console.log(`  飞书话题:  ${room.threadId}`)
  console.log(`  重进围观:  clawx room attach ${room.id}`)
  console.log(`  列出房间:  clawx room ls`)
  console.log(`  关闭房间:  clawx kill ${room.id}`)
  console.log(`  清理死房:  clawx room prune`)
  console.log('')
}

async function cmdRoom(positionals: string[], opts: Record<string, string>): Promise<void> {
  const first = positionals[0]
  const sub = first && ROOM_SUBS.has(first) ? first : undefined

  if (sub === 'init') {
    await runRoomInit()
    return
  }

  if (sub === undefined) {
    // Bare `clawx room` with no cwd/label/brief is almost always an
    // accidental invocation — show usage instead of spawning a room.
    if (!first && !opts.cwd && !opts.label && !opts.brief && !opts.topic && !opts['brief-file']) {
      console.log(ROOM_USAGE)
      return
    }
    let brief = opts.brief ?? opts.topic
    if (!brief && opts['brief-file']) {
      brief = fs.readFileSync(opts['brief-file'], 'utf8').trim()
    }
    // label falls back to brief head, then basename(cwd). No brief at all =
    // standby mode (describe the topic in the Feishu topic later).
    const cwdGuess = path.resolve(first ?? opts.cwd ?? process.cwd())
    const label = opts.label ?? (brief ? brief.slice(0, 30) : path.basename(cwdGuess))
    const larkCfg = loadLarkApps()
    let chatId = opts.chat
    if (!chatId && opts.group) {
      const resolved = larkCfg ? resolveGroupChat(larkCfg, opts.group) : null
      if (!resolved) {
        const known = Object.keys(larkCfg?.groups ?? {}).join(' / ') || '(无)'
        console.error(`✗ 未注册的群「${opts.group}」。已注册: ${known}`)
        process.exit(1)
      }
      chatId = resolved
    }
    chatId ??= larkCfg?.topicChatId ?? process.env.CLAWX_LARK_CHAT_ID
    if (!chatId) {
      console.error('✗ 缺飞书 chat:配置 lark-apps.json,或传 --chat <oc_...>')
      process.exit(1)
    }
    const cwd = cwdGuess
    const templateName = opts.template ?? opts.tpl ?? 'design'
    if (!loadTemplate(templateName, cwd)) {
      const avail = listTemplates(cwd).map((t) => `${t.name}(${t.source})`).join(' / ')
      console.error(`✗ 模板「${templateName}」不存在。可用: ${avail}`)
      process.exit(1)
    }
    const room = await launchRoom({ label, topic: brief, cwd, chatId, template: templateName })
    await ensureBridge(room.id)
    console.log(`✓ 房间已就绪${brief ? '' : '(待命:议题还没定)'} · rid ${room.id} · 模板 ${room.template} · 桥已转后台`)
    console.log(`  飞书: 话题「🆕 ${label}」${brief ? '' : ' · 📝 在话题里描述议题即开聊'}`)
    console.log(`  正在带你进 tmux 围观…(退出按 Ctrl-b 再按 d;别按 Ctrl+C——会打断 agent。房间照跑)`)
    spawnSync('tmux', ['attach', '-t', room.tmuxSession], { stdio: 'inherit' })
    printDetachSummary(room)
    return
  }

  if (sub === 'attach') {
    const id = positionals[1] ?? opts.id
    const room = id ? loadRoom(id) : null
    if (!room || !id) {
      console.error(`✗ room ${id ?? '?'} not found`)
      process.exit(1)
    }
    await ensureBridge(id)
    console.log(`  进入围观…(退出按 Ctrl-b 再按 d;别按 Ctrl+C——会打断 agent。房间照跑)`)
    spawnSync('tmux', ['attach', '-t', room.tmuxSession], { stdio: 'inherit' })
    printDetachSummary(room)
    return
  }

  if (sub === 'bridge') {
    const id = positionals[1] ?? opts.id
    const room = id ? loadRoom(id) : null
    if (!room) {
      console.error(`✗ room ${id ?? '?'} not found`)
      process.exit(1)
    }
    await runBridge(room)
    return
  }

  if (sub === 'ls') {
    const rooms = listRooms()
    if (rooms.length === 0) {
      console.log('(暂无房间)')
      return
    }
    for (const r of rooms) {
      const mark = (await tmuxAlive(r.tmuxSession)) ? '●' : '✗'
      console.log(`${mark} ${r.id}  ${r.status.padEnd(10)}  ${(r.label ?? '').slice(0, 24).padEnd(24)}  ${r.cwd}`)
    }
    return
  }

  if (sub === 'kill') {
    const id = positionals[1] ?? opts.id
    if (!id || !(await killRoomById(id))) {
      console.error(`✗ room ${id ?? '?'} not found`)
      process.exit(1)
    }
    return
  }

  if (sub === 'revive') {
    let n = 0
    for (const r of listRooms()) {
      if (r.status === 'ended') continue
      if (!(await tmuxAlive(r.tmuxSession))) continue
      await ensureBridge(r.id)
      n++
      console.log(`✓ ${r.id}  ${(r.label ?? '').slice(0, 24).padEnd(24)}  桥在后台`)
    }
    console.log(n === 0 ? '(没有需要拉活的房间)' : `✓ revive 完成:${n} 个房间,每间恰好一座桥`)
    return
  }

  if (sub === 'templates') {
    const cwd = path.resolve(positionals[1] ?? opts.cwd ?? process.cwd())
    const tpls = listTemplates(cwd)
    const mark = { project: '📁 项目', global: '🌐 全局', builtin: '⚙️  内置' }
    console.log(`可用模板(cwd=${cwd}):`)
    for (const t of tpls) {
      console.log(`  ${t.name.padEnd(14)} ${mark[t.source]}  ${t.description}`)
    }
    console.log(`\n用法: clawx room . --template <名>`)
    console.log(`新增: 放 <cwd>/.forge/templates/<名>.md(项目级) 或 ~/.config/clawx/templates/<名>.md(全局)`)
    return
  }

  if (sub === 'prune') {
    let removed = 0
    for (const r of listRooms()) {
      if (await tmuxAlive(r.tmuxSession)) continue
      // tmux gone → the room is dead regardless of recorded status; remove it.
      fs.rmSync(roomDir(r.id), { recursive: true, force: true })
      removed++
      console.log(`  ✗→🗑 ${r.id}  ${(r.label ?? r.topic).slice(0, 30)}`)
    }
    console.log(`✓ prune 完成:清掉 ${removed} 个死房间`)
    return
  }

  console.log(ROOM_USAGE)
}

/** Tear down a room by id: farewell ping into the topic → kill the bridge
 * pid(s) → kill the tmux session → mark the room `ended`. Returns false
 * WITHOUT side effects when no room owns this id, so the unified top-level
 * `clawx kill` can probe rooms first and fall through to a solo session.
 * Best-effort on the Feishu ping — a hiccup there must never block teardown. */
export async function killRoomById(id: string): Promise<boolean> {
  const room = loadRoom(id)
  if (!room) return false
  if (room.larkMode === 'topic' && room.threadRootId) {
    try {
      const cfg = loadLarkApps()
      if (cfg) {
        await new LarkFleet(cfg)
          .reader()
          .replyInThread(
            room.threadRootId,
            `🔚 房间已关闭(rid ${id})。tmux 会话与桥接已停;要继续协作请用 clawx room 新建一个。`,
          )
      }
    } catch {
      /* best-effort */
    }
  }
  const pids = new Set([room.bridgePid, readBridgeLockPid(id)])
  for (const pid of pids) {
    if (!pid) continue
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
  releaseBridgeLock(id)
  await killRoom(room)
  await updateRoom(id, (r) => ({ ...r, status: 'ended' as const }))
  console.log(`✓ 房间 ${id} 已关(tmux + 桥 已停)`)
  return true
}

export async function runRoomCli(argv: string[]): Promise<void> {
  const { opts, positionals } = parseArgs(argv)
  await cmdRoom(positionals, opts)
}
