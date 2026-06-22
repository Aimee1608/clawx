import fs from 'node:fs'
import http from 'node:http'

import { defaultTmuxSessionsPath } from './tmux-session-store.js'

/**
 * Hook shim. Configured globally in ~/.claude/settings.json under both
 * `hooks.Stop` and `hooks.PreToolUse`. The payload's `hook_event_name`
 * field tells us which one fired:
 *
 *   - "Stop"        → POST /api/internal/turn-done (final reply fanout)
 *   - "PreToolUse"  → POST /api/internal/turn-progress (⏳ reaction
 *                     on the user's message, first call per turn only)
 *
 * Fires after every claude assistant turn / tool use on this machine —
 * INCLUDING for non-tmux runs (ad-hoc `claude`, cron, etc.). To stay
 * cheap on the hot path:
 *   1. Read the small tmux-sessions.json
 *   2. Look up the firing session_id (= claude UUID); exit silently if
 *      it's not a clawx tmux session
 *   3. POST to the local clawx daemon so the heavy lifting runs there
 *
 * If the daemon isn't running, log to stderr and exit 0 — hooks MUST
 * NOT block the user's interactive claude, so we never error out.
 */
export async function runTmuxHook(): Promise<void> {
  let payload: unknown
  try {
    const stdin = await readStdin()
    payload = stdin ? JSON.parse(stdin) : null
  } catch (err) {
    // Malformed stdin → not our problem; let claude continue.
    process.stderr.write(
      `[clawx tmux-hook] failed to parse stdin: ${(err as Error).message}\n`,
    )
    return
  }

  const session_id = pick(payload, 'session_id')
  const transcript_path = pick(payload, 'transcript_path')
  const hook_event_name = pick(payload, 'hook_event_name') ?? 'Stop'
  // UserPromptSubmit payload carries the prompt text in a `prompt` key.
  // Other event types don't have it (or have different shapes), so the
  // null fallback is fine.
  const prompt = pick(payload, 'prompt')
  // PreToolUse payload carries the structured tool call. We pull
  // tool_name eagerly so we can branch on AskUserQuestion below
  // (claude's interactive picker UI doesn't work in detached tmux
  // mode — we block it and force the model to ask inline so the user
  // can reply via the Lark thread channel instead).
  const tool_name = pick(payload, 'tool_name')
  if (!session_id) return

  // Cheap filter: read tmux-sessions.json directly, skip if this UUID
  // isn't owned by clawx.
  const sessionsPath = defaultTmuxSessionsPath()
  if (!fs.existsSync(sessionsPath)) return
  let raw: string
  try {
    raw = fs.readFileSync(sessionsPath, 'utf8')
  } catch {
    return
  }
  let known = false
  try {
    const data = JSON.parse(raw) as { sessions?: Array<{ claudeUuid?: string }> }
    known = !!data.sessions?.some((s) => s.claudeUuid === session_id)
  } catch {
    return
  }
  if (!known) return

  // Fire-and-forget POST. We deliberately don't await success — hooks
  // have a 600s default timeout in claude, and we want to be in & out
  // fast. The daemon does the actual work asynchronously.
  const port = Number(process.env.CLAWX_WEB_PORT) || 8124
  const host = '127.0.0.1'
  // Special case: AskUserQuestion. Claude Code's interactive picker
  // doesn't work in detached tmux mode (the user is replying via
  // Lark thread, not the terminal UI). Block it via exit 2 so the
  // model retries by asking inline as plain text, and surface what it
  // tried to ask via the daemon → Lark thread for visibility.
  const isAskUserQuestion =
    hook_event_name === 'PreToolUse' && tool_name === 'AskUserQuestion'
  // Route by hook event:
  //   - UserPromptSubmit → turn-start (echo + bind msg_id)
  //   - PreToolUse(AskUserQuestion) → ask-question (surface + block)
  //   - PreToolUse(other) → turn-progress (⏳ reaction)
  //   - Stop (and others) → turn-done (final reply fanout)
  let apiPath: string
  if (isAskUserQuestion) apiPath = '/api/internal/ask-question'
  else if (hook_event_name === 'UserPromptSubmit') apiPath = '/api/internal/turn-start'
  else if (hook_event_name === 'PreToolUse') apiPath = '/api/internal/turn-progress'
  else apiPath = '/api/internal/turn-done'
  // For ask-question we need the structured tool_input (questions[]).
  // We pass the whole payload through so the daemon doesn't have to
  // re-parse stdin: the daemon picks what it needs.
  const body = JSON.stringify({
    claude_uuid: session_id,
    transcript_path: transcript_path ?? null,
    hook_event_name,
    tool_name,
    tool_input: isAskUserQuestion
      ? (payload as Record<string, unknown>).tool_input ?? null
      : null,
    prompt,
  })

  // POST with retry on connection-refused: covers the race where the
  // daemon is mid-restart (kill + start can leave a 1-3s window where
  // localhost:8124 returns ECONNREFUSED). Without this retry, a Stop
  // hook firing in that window silently drops the turn — the
  // assistant reply is in jsonl but never reaches Lark.
  //
  // Up to 4 attempts × ~500ms each = under 2s total worst case.
  // Plenty for a typical daemon restart; bounded enough that we
  // don't block claude's REPL.
  const MAX_ATTEMPTS = 4
  const RETRY_DELAY_MS = 500
  let posted = false
  for (let attempt = 0; attempt < MAX_ATTEMPTS && !posted; attempt++) {
    posted = await new Promise<boolean>((resolve) => {
      const req = http.request(
        {
          host,
          port,
          path: apiPath,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
          timeout: 3_000,
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve(true))
          res.on('error', () => resolve(false))
        },
      )
      req.on('error', (err: NodeJS.ErrnoException) => {
        // ECONNREFUSED / EADDRNOTAVAIL = daemon mid-restart, retry.
        // Other errors (DNS, etc.) — log and give up.
        if (err.code === 'ECONNREFUSED' || err.code === 'EADDRNOTAVAIL') {
          resolve(false)
        } else {
          process.stderr.write(
            `[clawx tmux-hook] daemon unreachable (${err.code ?? 'unknown'}): ${err.message}\n`,
          )
          resolve(true) // skip retry for non-recoverable errors
        }
      })
      req.on('timeout', () => {
        req.destroy()
        process.stderr.write('[clawx tmux-hook] daemon timeout\n')
        resolve(true) // don't retry timeouts — daemon is up but stuck
      })
      req.write(body)
      req.end()
    })
    if (!posted && attempt < MAX_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
    }
  }
  if (!posted) {
    process.stderr.write(
      `[clawx tmux-hook] daemon unreachable after ${MAX_ATTEMPTS} attempts (was it restarting?)\n`,
    )
  }

  // AskUserQuestion block: exit 2 with feedback so claude sees the
  // reason and retries inline. The stderr text becomes the "tool
  // blocked" message visible to the model. Keep it directive and in
  // both languages — Claude Code's hook-feedback parsing is purely
  // text-based and the model just incorporates it as context.
  if (isAskUserQuestion) {
    process.stderr.write(
      [
        'AskUserQuestion is BLOCKED in this clawx tmux session.',
        'The user is replying via a Lark thread, not the terminal UI,',
        'so your interactive picker would be invisible and unanswerable.',
        '',
        '⚠️  IMPORTANT: Do NOT call any other tools after this block.',
        'Your NEXT response MUST be plain text only — no tool calls.',
        'Write your question directly as plain text in your response.',
        'If you have options, list them inline: A. xxx / B. xxx / C. xxx',
        'The user will reply via Lark thread with their text choice.',
        '',
        '重要：接下来禁止调用任何工具。直接用纯文字回复你的问题即可，',
        '不要产生任何 tool call。用户已在 Lark 话题看到你想问的内容，',
        '会直接在话题里文字回复。',
      ].join('\n'),
    )
    process.exit(2)
  }
}

function pick(obj: unknown, key: string): string | null {
  if (obj && typeof obj === 'object' && key in obj) {
    const v = (obj as Record<string, unknown>)[key]
    return typeof v === 'string' ? v : null
  }
  return null
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve('')
      return
    }
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}
