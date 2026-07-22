import fs from 'node:fs'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'

import type { AgentKind } from './agent-backend.js'
import { locateCodexSession } from './codex-sessions.js'
import { loadUserConfigFile, resolveTmuxDir } from './config.js'

export interface RunTmuxOptions {
  /** Working directory for the claude REPL. Optional when resumeUuid
   * is given — we'll try to read the cwd off the existing jsonl. */
  cwd?: string
  /** When set, the new tmux pane runs `claude --resume <uuid>` so the
   * prior conversation continues in-place. Used to recover from an
   * accidentally killed session. */
  resumeUuid?: string
  /** Optional short title for the session — surfaces as the first line
   * of the Lark thread seed message. Strongly recommended when this
   * machine has multiple long-lived sessions in the same group. */
  label?: string
  /** Optional named topic group (config `tmuxThreadChats`) the Lark
   * thread is created in. Omit to use the default group. */
  group?: string
  agent?: AgentKind
}

/**
 * `clawx tmux [cwd] [--resume <uuid>]` — third entry point (alongside
 * Lark's `/new-tmux` and the web Tmux tab) for spawning a long-running
 * claude REPL inside a tmux session.
 *
 * Flow:
 *   1. POST to the running clawx daemon on `:8124` so the session
 *      gets registered in tmux-session-store AND a Lark thread is
 *      created (when configured). Result: bot, web, and this CLI all
 *      see the same session, can route inbound messages, and fan out
 *      turn-done events to Lark.
 *   2. exec `tmux attach -t <name>` so the user's terminal immediately
 *      becomes the live REPL view. Detach with Ctrl-b d.
 *
 * Requires:
 *   - clawx daemon running locally (`clawx start` or
 *     `clawx daemon start`).
 *   - tmux binary on PATH.
 */
export async function runTmux(opts: RunTmuxOptions = {}): Promise<void> {
  const resumeUuid = opts.resumeUuid?.trim() || undefined
  const label = opts.label?.trim() || undefined
  const group = opts.group?.trim() || undefined
  const agent = opts.agent ?? 'claude'
  let cwd = (opts.cwd ?? '').trim()

  if (resumeUuid && !cwd) {
    // Auto-detect cwd by reading the existing jsonl. claude stores its
    // session transcripts under ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
    // and every line of the jsonl includes a "cwd" field — read the
    // first line and pull it out so the user doesn't have to retype
    // the path they just lost.
    const detected = agent === 'codex'
      ? locateCodexSession(resumeUuid)?.cwd
      : detectCwdFromUuid(resumeUuid)
    if (!detected) {
      process.stderr.write(
        `✗ couldn't auto-detect cwd for ${agent} session ${resumeUuid}\n` +
          `  retry with explicit cwd: clawx tmux --agent ${agent} --resume ${resumeUuid} <cwd>\n`,
      )
      process.exit(1)
    }
    cwd = detected
    process.stdout.write(`(auto-detected cwd from jsonl: ${cwd})\n`)
  }

  if (!cwd) cwd = process.cwd()

  const port = Number(process.env.CLAWX_WEB_PORT) || 8124
  const host = '127.0.0.1'

  if (resumeUuid) {
    process.stdout.write(
      `Resuming ${agent} session=${resumeUuid} (cwd=${cwd}) via daemon http://${host}:${port}…\n`,
    )
  } else {
    process.stdout.write(`Creating tmux ${agent} session for cwd=${cwd} via daemon http://${host}:${port}…\n`)
  }

  const body = JSON.stringify({ cwd, source: 'cli', resumeUuid, label, group, agent })
  const result = await new Promise<{ ok: boolean; entry?: any; error?: string }>(
    (resolve) => {
      const req = http.request(
        {
          host,
          port,
          path: '/api/tmux-sessions',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
          timeout: 60_000,
        },
        (res) => {
          let buf = ''
          res.setEncoding('utf8')
          res.on('data', (c) => (buf += c))
          res.on('end', () => {
            try {
              resolve(JSON.parse(buf))
            } catch {
              resolve({ ok: false, error: `bad response: ${buf.slice(0, 200)}` })
            }
          })
        },
      )
      req.on('error', (err) =>
        resolve({ ok: false, error: `daemon unreachable: ${err.message}` }),
      )
      req.on('timeout', () => {
        req.destroy()
        resolve({ ok: false, error: 'daemon timeout (60s) — is it running?' })
      })
      req.write(body)
      req.end()
    },
  )

  if (!result.ok || !result.entry) {
    process.stderr.write(`✗ ${result.error ?? 'unknown failure'}\n`)
    process.stderr.write(
      `Hint: is the clawx daemon running? Try \`curl http://${host}:${port}/api/status\`.\n`,
    )
    process.exit(1)
  }

  const entry = result.entry as {
    sessionId: string
    tmuxName: string
    claudeUuid?: string
    agentKind?: AgentKind
    agentSessionId?: string
    threadId?: string
    cwd: string
    label?: string
    createdAt?: string
  }

  process.stdout.write('\n')
  process.stdout.write(`✓ tmux session ready\n`)
  process.stdout.write(`  agent:     ${entry.agentKind ?? 'claude'}\n`)
  process.stdout.write(`  sessionId: ${entry.sessionId}\n`)
  process.stdout.write(`  tmuxName:  ${entry.tmuxName}\n`)
  process.stdout.write(`  cwd:       ${entry.cwd}\n`)
  if (entry.claudeUuid) {
    process.stdout.write(`  claudeUuid: ${entry.claudeUuid}\n`)
  }
  if (entry.agentSessionId && entry.agentSessionId !== entry.claudeUuid) {
    process.stdout.write(`  agentId:   ${entry.agentSessionId}\n`)
  }
  if (entry.threadId) {
    process.stdout.write(`  Lark thread: ${entry.threadId}\n`)
  } else {
    process.stdout.write(
      `  (no Lark thread — daemon not configured with tmuxThreadChatId)\n`,
    )
  }
  process.stdout.write(`\n`)
  process.stdout.write(`Attaching to ${entry.tmuxName}… (Ctrl-b d to detach)\n`)
  process.stdout.write('\n')

  // Hand the current terminal over to tmux. stdio: 'inherit' ties the
  // current TTY straight to the tmux client so the user sees + types
  // into the live claude REPL. When they `Ctrl-b d`, tmux exits, the
  // session keeps running, and this command returns 0.
  const tmuxCmd = process.env.CLAWX_TMUX_CMD?.trim() || 'tmux'
  const ret = spawnSync(tmuxCmd, ['attach', '-t', entry.tmuxName], {
    stdio: 'inherit',
  })
  if (ret.error) {
    process.stderr.write(`✗ failed to spawn ${tmuxCmd}: ${ret.error.message}\n`)
    process.exit(1)
  }

  // Detach summary — so when the user Ctrl-b d's out of a session
  // their shell scrollback ends with WHAT they just left and HOW to
  // re-attach. Useful when running many sessions in parallel.
  const displayTitle = entry.label?.trim() || path.basename(entry.cwd) || entry.sessionId
  const createdShown = entry.createdAt
    ? new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
        .format(new Date(entry.createdAt))
        .replace(',', '')
    : '—'
  // Did the tmux session survive the detach? If the REPL process exited
  // (you /exit'd, or the agent died on launch — e.g. the codex update-prompt
  // hang), the session is GONE and `tmux attach` would just print "can't
  // find session". So probe liveness and only show Re-attach when it's real;
  // otherwise say "exited" and point at Resume, which respawns the same
  // conversation (--resume) and re-binds the Lark thread.
  const stillAlive =
    spawnSync(tmuxCmd, ['has-session', '-t', entry.tmuxName], { stdio: 'ignore' }).status === 0
  // `entry` is the creation-time snapshot. A codex session id is minted by
  // codex itself and backfilled into the store only AFTER it starts, so at
  // creation `agentSessionId` is still pending — without a refresh the Resume
  // line would never show it. Re-fetch the live entry from the daemon so the
  // codex resume id surfaces. (claude already carries its id from creation,
  // so this just re-confirms the same value; a daemon hiccup falls back to it.)
  let resumeId = entry.agentSessionId ?? entry.claudeUuid
  try {
    const live = await daemonJson(host, port, 'GET', '/api/tmux-sessions')
    const sessions =
      (live.ok &&
        (
          live.body as {
            sessions?: Array<{ sessionId: string; agentSessionId?: string; claudeUuid?: string }>
          }
        )?.sessions) ||
      []
    const fresh = sessions.find((s) => s.sessionId === entry.sessionId)
    if (fresh) resumeId = fresh.agentSessionId ?? fresh.claudeUuid ?? resumeId
  } catch {
    /* daemon hiccup — keep the creation-time id */
  }
  process.stdout.write('\n')
  process.stdout.write(
    stillAlive
      ? `✓ Detached from "${displayTitle}"\n`
      : `✓ Session "${displayTitle}" exited (tmux session closed)\n`,
  )
  process.stdout.write(`  sid: ${entry.sessionId}\n`)
  process.stdout.write(`  cwd: ${entry.cwd}\n`)
  process.stdout.write(`  created: ${createdShown} CST\n`)
  if (stillAlive) {
    process.stdout.write(`  Re-attach:  tmux attach -t ${entry.tmuxName}\n`)
  }
  if (resumeId) {
    // Respawns a fresh process on the SAME conversation: context preserved
    // via --resume, and clawx re-binds this same Lark thread.
    process.stdout.write(
      `  Resume:     clawx solo --agent ${entry.agentKind ?? 'claude'} --resume ${resumeId}\n`,
    )
  } else if (!stillAlive) {
    // Session died before it ever bound an agent session id (nothing to
    // --resume) — the only way forward is a fresh start in the same cwd.
    process.stdout.write(
      `  Recreate:   clawx solo ${JSON.stringify(entry.cwd)} --agent ${entry.agentKind ?? 'claude'}\n`,
    )
  }
  // Tear the session down completely: kills the tmux session if it's
  // still around, drops the store record, and posts a 🧹 notice into the
  // Lark thread.
  process.stdout.write(`  清理/Kill:  clawx kill ${entry.sessionId}\n`)
  if (entry.threadId) {
    process.stdout.write(`  Lark 话题:   ${entry.threadId}\n`)
  }
  process.stdout.write('\n')
  process.exit(ret.status ?? 0)
}

/** Tiny path helper exposed for tests; resolves a possibly-relative
 * cwd argument against the CLI invocation's working directory.
 * Returns undefined when no arg was supplied so the caller can decide
 * whether to default to process.cwd() (fresh session) or auto-detect
 * (resume session — uuid implies cwd via the jsonl). */
export function resolveCwdArg(arg: string | undefined): string | undefined {
  if (!arg || !arg.trim()) return undefined
  // A `tmuxDirs` alias (e.g. `clawx solo riff`) wins over path
  // resolution, so the same aliases work from the terminal as from
  // Feishu `/new`. resolveTmuxDir returns the arg unchanged on a miss.
  const resolved = resolveTmuxDir(arg.trim(), loadUserConfigFile().tmuxDirs)
  if (resolved !== arg.trim()) return resolved
  return path.isAbsolute(arg) ? arg : path.resolve(process.cwd(), arg)
}

/** Walk ~/.claude/projects to find <uuid>.jsonl, then read the first
 * line and pull the "cwd" field out. Returns undefined if we can't
 * find the file or can't parse it.
 *
 * Claude's transcript format puts a `"cwd": "..."` on essentially every
 * line; we read up to 64 KB and JSON-parse the first complete line. */
function detectCwdFromUuid(uuid: string): string | undefined {
  const root = path.join(os.homedir(), '.claude', 'projects')
  if (!fs.existsSync(root)) return undefined
  let projects: string[]
  try {
    projects = fs.readdirSync(root)
  } catch {
    return undefined
  }
  for (const proj of projects) {
    const file = path.join(root, proj, `${uuid}.jsonl`)
    if (!fs.existsSync(file)) continue
    try {
      // The leading lines (permission-mode, snapshot) don't carry cwd —
      // the first user-message line does. Scan up to the first 50
      // non-empty lines and return the first cwd we see.
      const buf = fs.readFileSync(file, { encoding: 'utf8' })
      const lines = buf.split('\n').filter((l) => l.trim())
      for (const l of lines.slice(0, 50)) {
        try {
          const obj = JSON.parse(l) as { cwd?: unknown }
          if (typeof obj.cwd === 'string' && obj.cwd.trim()) return obj.cwd
        } catch {
          /* skip malformed line */
        }
      }
    } catch {
      /* try next match — rare but possible if jsonl is corrupted */
    }
  }
  return undefined
}

// ── tmux admin: ls / kill / prune ──────────────────────────────────
// `clawx tmux <ls|kill|prune>` manages existing sessions through the
// daemon's HTTP API, so a kill always does tmux kill-session + store
// cleanup together (never leaving a zombie record). Liveness is checked
// locally with `tmux has-session` since the daemon's list doesn't carry
// it.

interface AdminSession {
  sessionId: string
  tmuxName: string
  cwd: string
  label?: string
  agentKind?: AgentKind
}

export async function runTmuxAdmin(
  action: 'ls' | 'kill' | 'prune',
  sid?: string,
): Promise<void> {
  const port = Number(process.env.CLAWX_WEB_PORT) || 8124
  const host = '127.0.0.1'
  const tmuxCmd = process.env.CLAWX_TMUX_CMD?.trim() || 'tmux'

  if (action === 'kill') {
    const target = sid?.trim()
    if (!target) {
      process.stderr.write('✗ usage: clawx kill <sid>\n')
      process.exit(1)
    }
    const r = await daemonJson(host, port, 'DELETE', `/api/tmux-sessions/${encodeURIComponent(target)}`)
    if (r.ok && (r.body as { ok?: boolean })?.ok) {
      process.stdout.write(`✓ killed ${target} (tmux session + store record removed)\n`)
      return
    }
    process.stderr.write(
      `✗ failed to kill ${target}: ${r.error ?? (r.body as { error?: string })?.error ?? 'unknown'}\n`,
    )
    process.exit(1)
  }

  // ls / prune both need the list first.
  const r = await daemonJson(host, port, 'GET', '/api/tmux-sessions')
  if (!r.ok) {
    process.stderr.write(
      `✗ ${r.error}\n  Hint: is the daemon running? curl http://${host}:${port}/api/status\n`,
    )
    process.exit(1)
  }
  const sessions = ((r.body as { sessions?: AdminSession[] })?.sessions ?? []).map((s) => ({
    ...s,
    state: sessionState(tmuxCmd, s.tmuxName, s.agentKind ?? 'claude'),
  }))

  if (action === 'ls') {
    if (sessions.length === 0) {
      process.stdout.write('(no tmux sessions)\n')
      return
    }
    process.stdout.write(`${sessions.length} tmux session(s):\n\n`)
    for (const s of sessions) {
      const mark =
        s.state === 'alive' ? '● live ' : s.state === 'stale' ? '⚠ stale' : '✗ gone '
      process.stdout.write(`  ${mark}  ${s.sessionId}  [${s.agentKind ?? 'claude'}] [${s.label?.trim() || '—'}]  ${s.cwd}\n`)
    }
    const stale = sessions.filter((s) => s.state === 'stale').length
    const gone = sessions.filter((s) => s.state === 'gone').length
    if (stale + gone > 0) {
      const parts: string[] = []
      if (stale) parts.push(`${stale} stale (tmux 在 / claude 已退出)`)
      if (gone) parts.push(`${gone} gone (tmux 已无 / 记录残留)`)
      process.stdout.write(`\n  ${parts.join(', ')} — clean up with: clawx tmux prune\n`)
    }
    return
  }

  // prune: drop every session with no live claude — both `gone` (tmux
  // already vanished, just a stale record) and `stale` (tmux shell still
  // there but claude exited). DELETE kills the tmux session (if any) and
  // clears the store record together.
  const dead = sessions.filter((s) => s.state !== 'alive')
  if (dead.length === 0) {
    process.stdout.write('✓ no dead sessions to prune (all have a live claude)\n')
    return
  }
  process.stdout.write(`Pruning ${dead.length} dead session(s)…\n`)
  let ok = 0
  for (const s of dead) {
    const d = await daemonJson(host, port, 'DELETE', `/api/tmux-sessions/${encodeURIComponent(s.sessionId)}`)
    const tag = s.state === 'stale' ? 'killed shell + record' : 'cleared record'
    if (d.ok && (d.body as { ok?: boolean })?.ok) {
      process.stdout.write(`  ✓ ${s.sessionId}  [${s.label?.trim() || '—'}]  (${tag})\n`)
      ok++
    } else {
      process.stdout.write(`  ✗ ${s.sessionId}: ${d.error ?? 'failed'}\n`)
    }
  }
  process.stdout.write(`\n✓ pruned ${ok}/${dead.length}\n`)
}

/** alive = tmux session exists AND its pane is running claude;
 *  stale = tmux session exists but claude has exited (pane fell back to a
 *          shell, or the pane is dead); gone = no tmux session at all
 *          (just a leftover store record). */
function sessionState(tmuxCmd: string, name: string, agentKind: AgentKind): 'alive' | 'stale' | 'gone' {
  const has = spawnSync(tmuxCmd, ['has-session', '-t', name], { stdio: 'ignore' })
  if (has.status !== 0) return 'gone'
  const r = spawnSync(
    tmuxCmd,
    ['list-panes', '-t', name, '-F', '#{pane_current_command} #{pane_dead}'],
    { encoding: 'utf8' },
  )
  const line = (r.stdout || '').trim().split('\n')[0] ?? ''
  const [cmd, dead] = line.split(' ')
  if (dead === '1') return 'stale'
  const expected = agentKind === 'codex' ? /codex/i : /claude/i
  return cmd && expected.test(cmd) ? 'alive' : 'stale'
}

function daemonJson(
  host: string,
  port: number,
  method: string,
  apiPath: string,
): Promise<{ ok: boolean; body?: unknown; error?: string }> {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path: apiPath, method, timeout: 10_000 }, (res) => {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (buf += c))
      res.on('end', () => {
        try {
          resolve({ ok: true, body: JSON.parse(buf) })
        } catch {
          resolve({ ok: false, error: `bad response: ${buf.slice(0, 120)}` })
        }
      })
    })
    req.on('error', (err) => resolve({ ok: false, error: `daemon unreachable: ${err.message}` }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, error: 'daemon timeout (10s)' })
    })
    req.end()
  })
}
