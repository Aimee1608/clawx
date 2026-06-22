#!/usr/bin/env node
/**
 * `clawx` CLI entry.
 *
 * Subcommands:
 *   clawx start             Hub mode (poll agent-platform short-connection webhook)
 *   clawx start --ws        WSClient long-connection directly to Feishu
 *   clawx daemon start      Run as pm2-managed background process
 *   clawx daemon stop       Stop + remove the pm2-managed process
 *   clawx daemon status     Show pm2 status for clawx
 *   clawx daemon logs       Tail pm2 logs (Ctrl-C to exit)
 *   clawx web               Open the web UI in the default browser
 *   clawx mcp-server        Start the clawx-manager MCP server on stdio
 *                             (consumed by the bot's claude subprocess via --mcp-config)
 *   clawx install-skill     Copy the clawx-manager skill to ~/.claude/skills/
 *   clawx uninstall-skill   Remove the installed clawx-manager skill
 *   clawx doctor            Run environment diagnostics (claude CLI, HUB reachability, token)
 *   clawx version           Print version
 *   clawx help              Print usage
 *
 * CLI flags (override env + config file):
 *   --cwd <path>              Override CLAUDE_CWD
 *   --lark-app-id <id>        Override LARK_APP_ID
 *   --lark-app-secret <sec>   Override LARK_APP_SECRET
 *   -h, --help                Print usage
 *   -v, --version             Print version
 */
import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { ensureProxyEnv } from './proxy-env.js'
import { normalizeAgentKind } from './agent-backend.js'

export interface CliOverrides {
  claudeCwd?: string
  larkAppId?: string
  larkAppSecret?: string
}

function readOwnVersion(): string {
  try {
    // Resolve package.json relative to the compiled cli.js in dist/.
    const here = path.dirname(fileURLToPath(import.meta.url))
    const candidates = [
      path.resolve(here, '../package.json'), // dist/cli.js → ../package.json (npm install layout)
      path.resolve(here, '../../package.json'), // src/cli.ts under tsx watch
    ]
    for (const c of candidates) {
      try {
        const pkg = JSON.parse(readFileSync(c, 'utf8')) as { version?: string }
        if (pkg.version) return pkg.version
      } catch {
        /* try next */
      }
    }
  } catch {
    /* ignore */
  }
  return 'unknown'
}

function printUsage(): void {
  process.stdout.write(
    [
      'clawx — persistent Claude Code sessions over terminal / Lark / web.',
      '  · solo — single agent (tmux session)   · room — multi-agent (Agent Teams + Lark)',
      '',
      'Usage:',
      '  clawx init                          First-run interactive setup',
      '                                          (Lark app, chat_id, workspace…)',
      '  clawx start [flags...]              Run in foreground (default)',
      '  clawx daemon start [flags]          Run as pm2-managed background process',
      '  clawx daemon stop                   Stop + remove pm2 process',
      '  clawx daemon status                 Show pm2 status',
      '  clawx daemon logs                   Tail pm2 logs',
      '  clawx tmux [cwd]                    Create a tmux+claude session via the',
      '                                          local daemon, then attach this terminal',
      '                                          to it (third entry point alongside the',
      '                                          Lark /new-tmux command and the web tab).',
      '  clawx tmux --resume <uuid> [cwd]    Same, but spawn `claude --resume <uuid>`',
      '                                          so a prior conversation continues. cwd is',
      '                                          auto-detected from the jsonl when omitted.',
      '  clawx tmux [cwd] --label "..."      Set the Lark thread title for this session.',
      '                                          Strongly recommended when you keep many',
      '                                          long-lived sessions in the same group.',
      '  clawx tmux [cwd] --group <name>     Create the thread in a named group',
      '                                          (config tmuxThreadChats); omit for default.',
      '  clawx tmux --agent codex [cwd]      Create a tmux+Codex session. Omit',
      '                                          --agent to keep the default Claude behavior.',
      '  clawx tmux ls                       List sessions (● alive / ✗ dead).',
      '  clawx tmux kill <sid>               Kill a session + drop its store record.',
      '  clawx tmux prune                    Remove all dead (zombie) session records.',
      '  clawx solo [...]                    Alias for `clawx tmux` (single-agent).',
      '  clawx room [cwd] --template <name>  Multi-agent room (Agent Teams + Lark topic).',
      '  clawx room ls|revive|kill|templates Manage rooms (templates = list templates).',
      '  clawx install-tmux-hook             Register the Stop hook in',
      '                                          ~/.claude/settings.json',
      '  clawx install-codex-hook            Register Codex hooks in ~/.codex/hooks.json',
      '  clawx web                           Open web UI in browser',
      '  clawx doctor                        Run environment diagnostics',
      '  clawx version',
      '  clawx help',
      '',
      'Flags:',
      '  --cwd <path>             Override CLAUDE_CWD env',
      '  --lark-app-id <id>       Override LARK_APP_ID env',
      '  --lark-app-secret <s>    Override LARK_APP_SECRET env',
      '  -h, --help               Print this help',
      '  -v, --version            Print version',
      '',
      'Config resolution (priority high → low):',
      '  1. CLI flags',
      '  2. Process env (including .env in CWD if present)',
      '  3. ~/.config/clawx/config.json',
      '  4. Built-in defaults',
      '',
    ].join('\n'),
  )
}

async function main(): Promise<void> {
  const rawCmd = process.argv[2]
  // Must run before any module that may reach api.anthropic.com — pins
  // every downstream subprocess (claude CLI, claude-agent-sdk query)
  // to mihomo regardless of the launching shell's env.
  if (rawCmd !== 'codex-hook') ensureProxyEnv()

  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: false,
    options: {
      ws: { type: 'boolean' }, // accepted for backwards-compat, ignored
      cwd: { type: 'string' },
      'lark-app-id': { type: 'string' },
      'lark-app-secret': { type: 'string' },
      resume: { type: 'string' }, // clawx tmux --resume <claudeUuid>
      label: { type: 'string' }, // clawx tmux --label "标题"
      group: { type: 'string' }, // clawx tmux --group <name> → topic group
      agent: { type: 'string' }, // clawx tmux --agent <claude|codex>
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  })

  if (values.help) {
    printUsage()
    return
  }
  if (values.version) {
    process.stdout.write(`${readOwnVersion()}\n`)
    return
  }

  const cmd = positionals[0] ?? 'help'

  const overrides: CliOverrides = {
    claudeCwd: typeof values.cwd === 'string' ? values.cwd : undefined,
    larkAppId: typeof values['lark-app-id'] === 'string' ? values['lark-app-id'] : undefined,
    larkAppSecret:
      typeof values['lark-app-secret'] === 'string' ? values['lark-app-secret'] : undefined,
  }

  switch (cmd) {
    case 'start': {
      // Hub mode was removed in the tmux-only refactor (see
      // commit history). All invocations now go through WS mode.
      // `--ws` is accepted but ignored for backwards-compat.
      const mod = await import('./ws-main.js')
      await mod.runWs(overrides)
      return
    }
    case 'daemon': {
      const sub = positionals[1] ?? 'status'
      const daemon = await import('./daemon.js')
      switch (sub) {
        case 'start':
          await daemon.daemonStart({ overrides })
          return
        case 'stop':
          await daemon.daemonStop()
          return
        case 'status':
          await daemon.daemonStatus()
          return
        case 'logs':
          await daemon.daemonLogs()
          return
        default:
          process.stderr.write(`Unknown daemon subcommand: ${sub}\n`)
          printUsage()
          process.exit(2)
      }
      return
    }
    case 'web': {
      const port = Number(process.env.CLAWX_WEB_PORT) || 8124
      const url = `http://127.0.0.1:${port}`
      try {
        const opener = (await import('open')).default
        await opener(url)
        process.stdout.write(`opened ${url}\n`)
      } catch (err: any) {
        process.stdout.write(`open ${url} (browser launch failed: ${err?.message})\n`)
      }
      return
    }
    case 'tmux-hook': {
      // Stop-hook shim. Reads stdin JSON, filters by tmux-sessions.json,
      // POSTs to the local daemon. See src/tmux-hook.ts for the rationale.
      const mod = await import('./tmux-hook.js')
      await mod.runTmuxHook()
      return
    }
    case 'codex-hook': {
      const mod = await import('./codex-hook.js')
      await mod.runCodexHook()
      return
    }
    case 'agent-mcp-server': {
      // stdio MCP server consumed by the DM agent's `claude --mcp-config`.
      // Exposes list/create/kill/send/capture tools that call back to the
      // daemon's tmux-sessions HTTP API. Stays alive until stdin closes.
      const mod = await import('./agent-mcp-server.js')
      await mod.runAgentMcpServer()
      return
    }
    case 'solo': // alias: single-agent session (room = multi-agent)
    case 'tmux': {
      // `clawx tmux [cwd] [--resume <uuid>] [--label "..."]` —
      // creates a new tmux session (with Lark thread when configured)
      // via the local daemon, then exec's `tmux attach` so the user's
      // terminal becomes the live REPL. Third entry point alongside
      // Feishu /new-tmux and the web tab.
      //
      // With --resume <uuid>, the new pane runs `claude --resume <uuid>`
      // so the previous conversation context survives a killed pane.
      // cwd defaults to whatever is encoded in that uuid's jsonl.
      // --label sets the title shown in the Lark thread seed message.
      const mod = await import('./cli-tmux.js')
      // Admin subcommands: `clawx tmux <ls|kill|prune>`. Anything else
      // in that slot is treated as a cwd → create-session (backwards
      // compatible with `clawx tmux [cwd]`).
      const sub = positionals[1]
      if (sub === 'ls' || sub === 'kill' || sub === 'prune') {
        await mod.runTmuxAdmin(sub, positionals[2])
        return
      }
      const cwd = mod.resolveCwdArg(positionals[1])
      const resumeUuid = typeof values.resume === 'string' ? values.resume : undefined
      const label = typeof values.label === 'string' ? values.label : undefined
      const group = typeof values.group === 'string' ? values.group : undefined
      const agent = normalizeAgentKind(values.agent)
      if (!agent) {
        process.stderr.write('Unknown --agent. Use `claude` or `codex`.\n')
        process.exit(2)
      }
      await mod.runTmux({ cwd, resumeUuid, label, group, agent })
      return
    }
    case 'room': {
      // Multi-agent room (Agent Teams + Feishu topic bridge). Self-parses
      // its own argv slice, independent of this CLI's option schema.
      const mod = await import('./room/cli.js')
      await mod.runRoomCli(process.argv.slice(3))
      return
    }
    case 'install-tmux-hook': {
      const mod = await import('./install-tmux-hook.js')
      mod.runInstallTmuxHook(positionals[1])
      return
    }
    case 'install-codex-hook': {
      const mod = await import('./install-codex-hook.js')
      mod.runInstallCodexHook(positionals[1])
      return
    }
    case 'init': {
      // First-run interactive setup. Walks the operator through the
      // per-user values that the daemon refuses to start without:
      // Lark app credentials, the topic group chat_id, default
      // workspace, progress reaction emoji. Idempotent — re-running
      // shows current values as defaults.
      const mod = await import('./init.js')
      await mod.runInit()
      return
    }
    case 'doctor': {
      const mod = await import('./doctor.js')
      await mod.runDoctor(overrides)
      return
    }
    case 'version': {
      process.stdout.write(`${readOwnVersion()}\n`)
      return
    }
    case 'help':
    case undefined: {
      printUsage()
      return
    }
    default: {
      process.stderr.write(`Unknown command: ${cmd}\n\n`)
      printUsage()
      process.exit(2)
    }
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
