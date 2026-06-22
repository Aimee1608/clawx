import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

import {
  loadUserConfigFile,
  configDir,
  type UserConfigFile,
} from './config.js'

/**
 * `clawx init` — first-run interactive setup. Walks the operator
 * through the per-user values that the daemon refuses to start without,
 * writes them to `~/.config/clawx/config.json` (mode 0600), then
 * offers to register the Stop hook and run the doctor.
 *
 * Re-running is safe: existing values are shown as defaults and an
 * empty answer keeps them.
 */
export async function runInit(): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout })
  try {
    process.stdout.write(
      [
        '',
        '┌────────────────────────────────────────────────────┐',
        '│ clawx — 三端互通 Claude Code 代理 / 初次配置向导    │',
        '└────────────────────────────────────────────────────┘',
        '',
        '会问你 5 个值，全部回车 = 保留旧值。配置保存到:',
        `  ${configPath()}`,
        '',
        '提前准备：在 Lark 开发者后台开一个 internal 应用，',
        '拿到 App ID + App Secret，并把事件订阅切到 WSClient 长连接。',
        '完整步骤见 docs/lark-bot-setup.md。',
        '',
      ].join('\n'),
    )

    const existing = loadUserConfigFile()
    const next: UserConfigFile = { ...existing }

    next.larkAppId = (
      await ask(rl, '1) Lark App ID (cli_xxxx)', existing.larkAppId)
    ).trim() || existing.larkAppId

    next.larkAppSecret = (
      await ask(rl, '2) Lark App Secret', maskSecret(existing.larkAppSecret), true)
    ).trim() || existing.larkAppSecret

    next.tmuxThreadChatId = (
      await ask(
        rl,
        '3) tmux 话题群 chat_id (oc_xxxx) - 新建 session 会自动开话题',
        existing.tmuxThreadChatId,
      )
    ).trim() || existing.tmuxThreadChatId

    const cwdGuess = existing.claudeCwd || guessWorkspace()
    next.claudeCwd = (
      await ask(rl, '4) workspace 默认路径', cwdGuess)
    ).trim() || cwdGuess

    next.tmuxProgressEmoji = (
      await ask(
        rl,
        '5) 进度反应表情 (THINKING/OK/DONE/SMILE/THUMBSUP/HEART)',
        existing.tmuxProgressEmoji ?? 'THINKING',
      )
    ).trim() || existing.tmuxProgressEmoji || 'THINKING'

    // userOpenId 故意不在向导里问 — 它是 Lark 内部 ID，用户通常不知道。
    // 自动机制：你首次给 bot 发 DM 时 ws-main 自动写入 config，
    // 后续新建 session 才能 @-mention 你。
    if (!existing.userOpenId) {
      process.stdout.write(
        '\n[提示] userOpenId 留空 — 首次 DM bot 后会自动发现并写入。\n',
      )
    }

    process.stdout.write('\n--- 即将写入的配置 ---\n')
    process.stdout.write(formatPreview(next))
    const confirm = (await ask(rl, '\n确认保存? (y/N)', 'y')).trim().toLowerCase()
    if (confirm !== 'y' && confirm !== 'yes') {
      process.stdout.write('已取消，配置未变更。\n')
      return
    }

    writeConfig(next)
    process.stdout.write(`\n✓ 配置已保存到 ${configPath()} (mode 0600)\n\n`)

    // 安装 Stop / PreToolUse / UserPromptSubmit hooks
    const installHook = (
      await ask(rl, '现在注册 Claude Code hooks (Stop/PreToolUse/UserPromptSubmit)? (Y/n)', 'y')
    )
      .trim()
      .toLowerCase()
    if (installHook !== 'n' && installHook !== 'no') {
      const mod = await import('./install-tmux-hook.js')
      mod.runInstallTmuxHook()
    }

    process.stdout.write(
      [
        '',
        '下一步:',
        '  1) clawx doctor       — 自检（claude 二进制、proxy、Lark token）',
        '  2) clawx daemon start — 后台启动 daemon (pm2 托管)',
        '  3) 在 Lark 里 DM bot 任意一句，userOpenId 会自动写入',
        '  4) 在 Lark 话题群里 /new-tmux <cwd> [标题]，或者跑',
        '     `clawx tmux <cwd> --label "..."` 起第一个 session',
        '',
      ].join('\n'),
    )
  } finally {
    rl.close()
  }
}

async function ask(
  rl: readline.Interface,
  label: string,
  defaultValue?: string,
  secret = false,
): Promise<string> {
  const shown = defaultValue ? ` [${secret ? maskSecret(defaultValue) : defaultValue}]` : ''
  const answer = await rl.question(`${label}${shown}: `)
  return answer || defaultValue || ''
}

function maskSecret(s?: string): string {
  if (!s) return ''
  if (s.length <= 6) return '*'.repeat(s.length)
  return `${s.slice(0, 3)}***${s.slice(-3)}`
}

function guessWorkspace(): string {
  const candidates = [
    path.join(os.homedir(), 'workspace'),
    path.join(os.homedir(), 'code'),
    path.join(os.homedir(), 'work'),
    os.homedir(),
  ]
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c
    } catch {
      /* keep trying */
    }
  }
  return os.homedir()
}

function configPath(): string {
  return path.join(configDir(), 'config.json')
}

function writeConfig(data: UserConfigFile): void {
  const p = configPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, p)
}

function formatPreview(cfg: UserConfigFile): string {
  const view: Record<string, unknown> = { ...cfg }
  if (typeof view.larkAppSecret === 'string') {
    view.larkAppSecret = maskSecret(view.larkAppSecret)
  }
  return JSON.stringify(view, null, 2) + '\n'
}
