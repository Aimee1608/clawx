// `clawx room init` — interactive setup for the room multi-bot fleet.
// Walks the operator through the per-bot App ID/Secret, validates each
// token, auto-discovers bot open_ids, and writes ~/.config/clawx/lark-apps.json.
// (The single-agent `clawx init` only does the solo config.json; this is
// the room counterpart.)
import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import fs from 'node:fs'
import path from 'node:path'

import { configDir } from '../config.js'
import { LarkApp, type LarkAppsConfig } from './lark-multi.js'

const MEMBERS = [
  { key: 'lead', role: 'team-lead', name: '队长' },
  { key: 'proposer', role: 'proposer', name: '主案' },
  { key: 'challenger', role: 'challenger', name: '质询' },
]

function loadExisting(file: string): Partial<LarkAppsConfig> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as LarkAppsConfig
  } catch {
    return {}
  }
}

export async function runRoomInit(): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout })
  try {
    process.stdout.write(
      [
        '',
        '┌────────────────────────────────────────────────┐',
        '│ clawx room init — 多 bot fleet 配置向导          │',
        '└────────────────────────────────────────────────┘',
        '',
        '会问你:话题群 chat_id + 3 个 bot(队长/主案/质询)的 App ID/Secret。',
        '自动:校验每个 token、探测 bot open_id、生成 lark-apps.json。',
        '',
        '前置:先在飞书建一个开启「话题」模式的群,把 3 个 bot 都拉进去。',
        '建 app / 开权限步骤见 docs/lark-bot-setup.md。',
        '',
      ].join('\n'),
    )

    const file = path.join(configDir(), 'lark-apps.json')
    const existing = loadExisting(file)

    const topicChatId =
      (await rl.question(`话题群 chat_id (oc_...)${existing.topicChatId ? ` [${existing.topicChatId}]` : ''}: `)).trim() ||
      existing.topicChatId ||
      ''
    if (!topicChatId) {
      process.stdout.write('✗ 必须提供话题群 chat_id,已取消。\n')
      return
    }

    const apps: Record<string, { name: string; appId: string; appSecret: string }> = {}
    const botOpenIds: Record<string, string> = {}
    const roleMap: Record<string, string> = {}

    for (const m of MEMBERS) {
      process.stdout.write(`\n── ${m.name}(${m.key})──\n`)
      const appId = (await rl.question('  App ID (cli_...): ')).trim()
      const appSecret = (await rl.question('  App Secret: ')).trim()
      if (!appId || !appSecret) {
        process.stdout.write(`  ✗ 缺 App ID/Secret,已取消(三个 bot 都要填)。\n`)
        return
      }
      // Validate the credentials AND discover the bot open_id in one call
      // (botInfo internally fetches a tenant_access_token, so a bad secret
      // surfaces here instead of failing silently at room launch).
      const app = new LarkApp(m.key, { name: m.name, appId, appSecret })
      try {
        const info = await app.botInfo()
        botOpenIds[m.key] = info.openId
        process.stdout.write(`  ✓ ${info.name} · open_id ${info.openId.slice(0, 12)}…\n`)
      } catch (e) {
        process.stdout.write(
          `  ✗ 校验失败: ${(e as Error).message}\n` +
            `    (检查 App ID/Secret 是否正确、权限是否已「创建版本」发布)\n`,
        )
        return
      }
      apps[m.key] = { name: m.name, appId, appSecret }
      roleMap[m.role] = m.key
    }

    const userName =
      (await rl.question(`\n你的飞书名${existing.userName ? ` [${existing.userName}]` : ''}: `)).trim() ||
      existing.userName ||
      ''

    const cfg: LarkAppsConfig = {
      topicChatId,
      reader: 'lead',
      roleMap,
      apps,
      botOpenIds,
      ...(userName ? { userName } : {}),
      ...(existing.userAliases ? { userAliases: existing.userAliases } : {}),
      ...(existing.userOpenId ? { userOpenId: existing.userOpenId } : {}),
    }

    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, file)

    process.stdout.write(
      [
        '',
        `✓ 已写入 ${file} (mode 0600)`,
        '',
        '下一步:',
        '  1) 确认 3 个 bot 都已拉进话题群',
        '  2) clawx room <cwd> --template dev --brief "你的议题"',
        '  3) 你给任一 bot 发条消息,userOpenId 会自动学到(用于 @ 你)',
        '',
      ].join('\n'),
    )
  } finally {
    rl.close()
  }
}
