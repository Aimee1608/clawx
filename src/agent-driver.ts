import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { log } from './logger.js'
import { loadAgentState, saveAgentState } from './agent-state.js'

/**
 * DM agent driver. For each 1-on-1 DM that isn't a thread message or
 * a /new-tmux command, we spawn:
 *
 *   claude --print
 *          --output-format text
 *          --resume <agentClaudeUuid>      (or --session-id on first run)
 *          --permission-mode bypassPermissions
 *          --append-system-prompt "..."    (the agent's persona)
 *          --mcp-config /tmp/.../agent-mcp.json
 *
 * stdin = the user's DM text. stdout = the assistant's text reply.
 *
 * The MCP config points at our own CLI: `node dist/cli.js
 * agent-mcp-server`, which exposes list/create/kill/send/capture tools
 * (see src/agent-mcp-server.ts). Each tool call from the agent makes
 * an HTTP request back to the daemon (localhost:8124), so all ops
 * funnel through the same orchestrator that the web UI uses.
 *
 * One agent claude UUID is reused across DMs (persisted in
 * agent-state.json) so the agent has continuous context — "the session
 * you just created for markone" remains in memory.
 */

export interface AgentDriverOptions {
  /** Path to the `claude` binary. Defaults to env CLAUDE_CMD or 'claude'. */
  claudeCmd?: string
  /** cwd for the agent's claude process. Doesn't really matter — the
   * agent doesn't read code itself; tools handle the real work. */
  cwd?: string
  /** Hard timeout for one DM-to-reply turn. Default 5 min. */
  hardTimeoutMs?: number
}

export interface AgentDriver {
  /** Process a single user DM and return the agent's reply text.
   * Throws if claude exits non-zero or times out. */
  handle(prompt: string): Promise<string>
}

const AGENT_SYSTEM_PROMPT = [
  '你是 clawx 的通用助手 agent，跑在用户开发机上。',
  '',
  '你的主要工作：帮用户管理 tmux session（创建、列出、查状态、清理）。',
  '所有 ops 必须通过 MCP 工具完成 — 不要让用户自己跑命令。',
  '',
  '可用工具（前缀 mcp__clawx-ops__）:',
  '- list_tmux_sessions / list_cwd_suggestions  → 信息查询',
  '- create_tmux_session(cwd, label?)            → 创建',
  '- kill_tmux_session(sessionId)                → 清理（敏感, 见 #2）',
  '- send_to_tmux_session(sessionId, text)       → 给某个 session 转发消息',
  '- capture_tmux_pane(sessionId)                → 看某个 pane 当前在做什么',
  '',
  '原则：',
  '1. 用户描述含糊（"起一个 markone 的"）时，先 list_cwd_suggestions 找候选路径，确认后再创建。',
  '',
  '2. **kill_tmux_session 必须二次确认**：',
  '   - 第一轮：用户说"清理/砍/删除/杀掉"某个 session 时，你不能立即调 kill。',
  '     先 list_tmux_sessions 把候选列出来（sid + cwd + lastTurnAt + 是否有最近活动），',
  '     然后回复用户："准备砍 <sid> (<cwd>)，最后活动 <lastTurnAt>，确认请回复 sid。"',
  '   - 第二轮：用户必须明确**重新写一遍 sid 全名**（cli-tmux-xxxxxxxx 这种）才允许 kill。',
  '     用户只说"对/yes/确认"是不够的——避免你和用户串台砍错。',
  '   - 用户主动说"全部砍掉"/"clean up all" 时仍要先列再要求用户重复"全部砍掉 <第一个sid>" 这种，',
  '     哪怕烦，也不要假设。',
  '',
  '3. 回答简洁直接，不要复述工具结果的全部 JSON — 总结关键字段即可。',
  '4. 当前时间默认 Asia/Shanghai，用户多用中文表达。',
  '5. 你看不到 tmux 内 claude REPL 的工作内容；要查具体某个 session 的状态，用 capture_tmux_pane。',
].join('\n')

function ensureMcpConfigFile(): string {
  // Cached under XDG_DATA_HOME so it persists across restarts but
  // gets re-derived when the CLI install path changes.
  const xdg = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share')
  const dir = path.join(xdg, 'clawx')
  const file = path.join(dir, 'agent-mcp.json')

  const here = path.dirname(fileURLToPath(import.meta.url))
  let cliPath = path.resolve(here, 'cli.js')
  if (!fs.existsSync(cliPath)) {
    cliPath = path.resolve(here, 'cli.ts') // dev mode under tsx
  }

  const config = {
    mcpServers: {
      'clawx-ops': {
        command: process.execPath,
        args: cliPath.endsWith('.ts')
          ? ['--import', 'tsx', cliPath, 'agent-mcp-server']
          : [cliPath, 'agent-mcp-server'],
        env: {} as Record<string, string>,
      },
    },
  }

  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 })
  return file
}

/** Resolve a cwd through symlinks. claude encodes cwd via realpath into
 * `~/.claude/projects/<encoded>/<uuid>.jsonl` — if we spawn with a
 * symlink path the encoded dir differs and `--resume` can't find the
 * transcript. */
function resolveCwd(raw: string): string {
  try {
    return fs.realpathSync(raw)
  } catch {
    return raw
  }
}

export function createAgentDriver(opts: AgentDriverOptions = {}): AgentDriver {
  const claudeCmd = opts.claudeCmd?.trim() || process.env.CLAUDE_CMD?.trim() || 'claude'
  const ctorCwd = resolveCwd(
    opts.cwd?.trim() || process.env.CLAUDE_CWD?.trim() || os.homedir(),
  )
  const hardTimeoutMs = opts.hardTimeoutMs ?? 5 * 60_000

  return {
    async handle(prompt: string): Promise<string> {
      const state = loadAgentState()
      const mcpConfigPath = ensureMcpConfigFile()

      const args = [
        '--print',
        '--output-format',
        'text',
        '--permission-mode',
        'bypassPermissions',
        '--dangerously-skip-permissions',
        '--append-system-prompt',
        AGENT_SYSTEM_PROMPT,
        '--mcp-config',
        mcpConfigPath,
      ]

      // Find the transcript on disk. If found, ALSO recover the cwd
      // it was originally created in (decoded from the project dir
      // name) — claude `--resume` only finds the conversation when
      // we spawn it from the SAME cwd (the encoded-dir gate). Using
      // ctorCwd unconditionally fails when the caller's cwd differs
      // from where the agent's first ever DM was anchored.
      const projectsRoot = path.join(os.homedir(), '.claude', 'projects')
      let transcriptProjectDir: string | null = null
      try {
        if (fs.existsSync(projectsRoot)) {
          for (const proj of fs.readdirSync(projectsRoot)) {
            if (fs.existsSync(path.join(projectsRoot, proj, `${state.agentClaudeUuid}.jsonl`))) {
              transcriptProjectDir = proj
              break
            }
          }
        }
      } catch {
        /* fall through */
      }
      const transcriptExists = transcriptProjectDir !== null
      // Decode the project dir back to a cwd. claude's encoding is
      // realpath(cwd).replace(/[^A-Za-z0-9]/g, '-'), which loses
      // dots/dashes in the original path. The encoded dir starts with
      // `-` (the leading `/` of the absolute path). Replacing all `-`
      // with `/` is lossy but correct for the common case of paths
      // that don't contain `-` segments. As a safety net we verify
      // the decoded path exists on disk before using it.
      const decodedFromDir = transcriptProjectDir
        ? '/' + transcriptProjectDir.replace(/^-+/, '').replace(/-/g, '/')
        : null
      const decodedCwdSafe =
        decodedFromDir && fs.existsSync(decodedFromDir) ? decodedFromDir : null
      const spawnCwd = transcriptExists
        ? (decodedCwdSafe ?? state.cwd ?? ctorCwd)
        : ctorCwd

      if (transcriptExists) {
        args.push('--resume', state.agentClaudeUuid)
      } else {
        args.push('--session-id', state.agentClaudeUuid)
      }

      log.info('agent DM → claude', {
        promptPreview: prompt.slice(0, 80),
        resuming: transcriptExists,
        agentUuid: state.agentClaudeUuid,
        spawnCwd,
      })

      const startedAt = Date.now()
      return await new Promise<string>((resolve, reject) => {
        const child = spawn(claudeCmd, args, {
          cwd: spawnCwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: process.env,
        })

        let stdout = ''
        let stderr = ''
        const onChunk = (s: Buffer): void => {
          stdout += s.toString('utf8')
        }
        child.stdout?.on('data', onChunk)
        child.stderr?.on('data', (s: Buffer) => {
          stderr += s.toString('utf8')
        })

        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* ignore */
          }
          reject(new Error(`agent timed out after ${hardTimeoutMs}ms`))
        }, hardTimeoutMs)

        child.on('error', (err) => {
          clearTimeout(timer)
          reject(new Error(`agent spawn error: ${err.message}`))
        })

        child.on('exit', (code, signal) => {
          clearTimeout(timer)
          if (signal === 'SIGKILL' || signal === 'SIGTERM') {
            reject(new Error('agent process killed'))
            return
          }
          if (code === 0) {
            // Persist the state on first successful run so transcript
            // existence is consistent next time. (We already saved on
            // load; this is belt-and-suspenders.)
            if (!transcriptExists) {
              saveAgentState({ ...state, cwd: spawnCwd })
            }
            log.info('agent DM ← claude', {
              durationMs: Date.now() - startedAt,
              replyChars: stdout.length,
            })
            resolve(stdout.trim())
            return
          }
          const parts = [`agent exit code=${code}`]
          if (stderr) parts.push(`stderr: ${stderr.slice(0, 400)}`)
          if (stdout) parts.push(`stdout: ${stdout.slice(0, 400)}`)
          reject(new Error(parts.join(', ')))
        })

        try {
          child.stdin?.write(prompt)
          child.stdin?.end()
        } catch (err) {
          clearTimeout(timer)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    },
  }
}
