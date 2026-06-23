import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import 'dotenv/config'
import * as lark from '@larksuiteoapi/node-sdk'

import { SessionStore, defaultSessionsPath } from './session-store.js'
import { startCronEngine } from './cron-engine.js'
import { WsPushSender } from './push-sender.js'
import { log } from './logger.js'
import { startWebServer } from './web.js'
import type { CliOverrides } from './cli.js'
import { loadUserConfigFile, setUserOpenId } from './config.js'
import { TmuxSessionStore } from './tmux-session-store.js'
import { createTmuxOrchestrator } from './tmux-orchestrator.js'
import { createLarkThreadService } from './lark-thread.js'
import { createAgentDriver } from './agent-driver.js'
import { formatSeedText, buildBotReplyCard } from './seed-text.js'
import { downloadMessageResource } from './lark-resource.js'
import { createReplWatchdog } from './repl-watchdog.js'
import type { AgentKind } from './agent-backend.js'
import { locateCodexSession, readCodexMessagesFromRaw } from './codex-sessions.js'

/** Lark content-audit error: message body contains PII / sensitive
 * data the Lark DLP flagged (e.g. email addresses, phone numbers,
 * id numbers). We catch this specifically and retry with the offender
 * regex-masked + a "审计屏蔽" notice prepended so the user still gets
 * the text in some form. */
const LARK_AUDIT_FAIL_CODE = 230028

/** Extract Lark's structured error from an axios-wrapped failure.
 * The SDK throws AxiosError whose `response.data` is the original
 * `{code, msg}` body. Some flows wrap it further; walk both spots. */
function pickLarkError(err: any): { code?: number; msg?: string } {
  const data = err?.response?.data ?? null
  if (data && typeof data === 'object' && typeof data.code === 'number') {
    return { code: data.code, msg: typeof data.msg === 'string' ? data.msg : undefined }
  }
  return {}
}

/** Mask things Lark's DLP commonly rejects. Conservative — only
 * touches obvious PII patterns so it doesn't mangle code blocks. */
function redactPII(text: string): { redacted: string; counts: Record<string, number> } {
  const counts: Record<string, number> = {}
  let out = text
  // RFC-ish email — covers nearly all real addresses without false positives
  // on things like Markdown link syntax.
  out = out.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    () => {
      counts.email = (counts.email ?? 0) + 1
      return '<email redacted>'
    },
  )
  // Chinese mobile numbers (11 digits starting with 1, with optional
  // separators). Tightened to avoid eating 11-digit IDs.
  out = out.replace(
    /(?<!\d)1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g,
    () => {
      counts.phone = (counts.phone ?? 0) + 1
      return '<phone redacted>'
    },
  )
  return { redacted: out, counts }
}

/**
 * Post into a Lark thread with light retry on 5xx, and a one-shot
 * PII-redaction retry on Lark's content-audit failure (230028).
 *
 * - 5xx → exponential backoff up to 3 attempts (300ms, 900ms)
 * - 4xx audit → mask PII once, retry with notice prefix
 * - other 4xx → throw with the actual Lark code/msg in the error
 *
 * `postOnce(body)` is called with each attempt's working body. The
 * caller decides whether body is plain text (postInThread) or wrapped
 * in a card (postCardInThread + buildBotReplyCard) — postWithRetry
 * only cares about the body string for PII scrubbing.
 */
async function postWithRetry(
  postOnce: (body: string) => Promise<unknown>,
  body: string,
): Promise<void> {
  let lastErr: unknown
  let workingText = body
  let alreadyRedacted = false
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await postOnce(workingText)
      if (attempt > 0) log.info('lark postInThread recovered', { attempt })
      return
    } catch (err: any) {
      lastErr = err
      const larkErr = pickLarkError(err)
      const status =
        Number(err?.response?.status ?? err?.status ?? err?.message?.match(/status code (\d+)/)?.[1] ?? 0) || 0

      // Content-audit failure: scrub PII once and retry.
      if (!alreadyRedacted && larkErr.code === LARK_AUDIT_FAIL_CODE) {
        const { redacted, counts } = redactPII(workingText)
        if (redacted !== workingText) {
          const total = Object.values(counts).reduce((a, b) => a + b, 0)
          const summary = Object.entries(counts)
            .map(([k, v]) => `${v} ${k}`)
            .join(' / ')
          workingText = `⚠️ Lark 内容审计屏蔽了 ${total} 处敏感信息 (${summary})，已用占位符替换。\n\n${redacted}`
          alreadyRedacted = true
          log.warn('lark audit failed — retrying with PII redacted', {
            larkCode: larkErr.code,
            larkMsg: larkErr.msg,
            counts,
          })
          continue
        }
        // Found no PII to mask — can't recover; throw with details.
        const err2 = new Error(
          `lark audit blocked (code=${larkErr.code}): ${larkErr.msg ?? 'no msg'}`,
        )
        ;(err2 as any).larkCode = larkErr.code
        ;(err2 as any).larkMsg = larkErr.msg
        throw err2
      }

      if (status && status >= 400 && status < 500) {
        // Wrap with Lark's actual reason for the upstream caller's log line.
        const err2 = new Error(
          `lark ${status}${larkErr.code ? ` (code=${larkErr.code})` : ''}: ${larkErr.msg ?? err?.message ?? 'unknown'}`,
        )
        ;(err2 as any).larkCode = larkErr.code
        ;(err2 as any).larkMsg = larkErr.msg
        throw err2
      }
      log.warn('lark postInThread retrying', {
        attempt,
        status: status || null,
        err: err?.message ?? String(err),
      })
      await new Promise((r) => setTimeout(r, 300 * Math.pow(3, attempt)))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

function resolveWebPort(): number | null {
  if (process.env.CLAWX_WEB_PORT === '0') return null
  const fromEnv = Number(process.env.CLAWX_WEB_PORT)
  if (Number.isFinite(fromEnv) && fromEnv > 0 && fromEnv < 65536) return fromEnv
  return 8124
}

/** Find a claude transcript jsonl by its session uuid (scans
 * ~/.claude/projects/*). Used by the REPL watchdog to hand turn-done a
 * transcript path when it replays a Stop hook that never fired. */
function findTranscriptPath(uuid: string): string | undefined {
  const root = path.join(os.homedir(), '.claude', 'projects')
  let projects: string[]
  try {
    projects = fs.readdirSync(root)
  } catch {
    return undefined
  }
  for (const proj of projects) {
    const f = path.join(root, proj, `${uuid}.jsonl`)
    if (fs.existsSync(f)) return f
  }
  return undefined
}

function findAgentTranscriptPath(kind: AgentKind | undefined, id: string | undefined): string | undefined {
  if (!id) return undefined
  return (kind ?? 'claude') === 'codex'
    ? locateCodexSession(id)?.jsonlPath
    : findTranscriptPath(id)
}

/** POST to the daemon's own /api/internal/turn-done — same payload the
 * Stop-hook shim sends. Best-effort: resolves even on error/timeout. */
function postLocalTurnDone(
  port: number,
  claudeUuid: string,
  transcriptPath: string | undefined,
): Promise<void> {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      claude_uuid: claudeUuid,
      transcript_path: transcriptPath ?? '',
      recovered: true,
    })
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/internal/turn-done',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        timeout: 30_000,
      },
      (res) => {
        res.resume()
        res.on('end', resolve)
      },
    )
    req.on('error', () => resolve())
    req.on('timeout', () => {
      req.destroy()
      resolve()
    })
    req.write(body)
    req.end()
  })
}

function postLocalAgentTurnDone(
  port: number,
  agentKind: AgentKind,
  agentSessionId: string,
  transcriptPath: string | undefined,
): Promise<void> {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      agentKind,
      agentSessionId,
      transcriptPath: transcriptPath ?? '',
      recovered: true,
    })
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/internal/agent-turn-done',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        timeout: 30_000,
      },
      (res) => {
        res.resume()
        res.on('end', resolve)
      },
    )
    req.on('error', () => resolve())
    req.on('timeout', () => { req.destroy(); resolve() })
    req.write(body)
    req.end()
  })
}

interface WsConfig {
  appId: string
  appSecret: string
  claudeCmd: string
  codexCmd: string
  claudeCwd: string
  claudeTimeoutMs: number
  maxQueueSize: number
  instanceId: string
  machineName: string
  /** Lark chat_id for the tmux-mode session threads group. Optional —
   * /new-tmux refuses to run without it, but the rest of WS mode works
   * normally. */
  tmuxThreadChatId?: string
  /** Named extra topic groups for `clawx tmux --group <name>`. */
  tmuxThreadChats?: Record<string, string>
  /** Emoji_type for the PreToolUse-driven ⏳ progress reaction. Optional
   * — when unset the daemon falls back to "HOURGLASS". */
  tmuxProgressEmoji?: string
  /** Operator's own Lark open_id; used to @-mention them in seed
   * messages so they auto-subscribe to the new topic. May start
   * undefined and get filled in lazily on the first inbound DM. */
  userOpenId?: string
}

function loadWsConfig(overrides: CliOverrides = {}): WsConfig {
  // Priority: CLI flag > process.env (includes .env via dotenv) > ~/.config/clawx/config.json
  const fileCfg = loadUserConfigFile()
  const pick = (cli: string | undefined, envKey: string, fileKey: keyof typeof fileCfg): string | undefined => {
    if (cli && cli.trim()) return cli.trim()
    const fromEnv = process.env[envKey]?.trim()
    if (fromEnv) return fromEnv
    const fromFile = fileCfg[fileKey]
    return typeof fromFile === 'string' && fromFile.trim() ? fromFile.trim() : undefined
  }

  const appId = pick(overrides.larkAppId, 'LARK_APP_ID', 'larkAppId')
  const appSecret = pick(overrides.larkAppSecret, 'LARK_APP_SECRET', 'larkAppSecret')
  const claudeCwd = pick(overrides.claudeCwd, 'CLAUDE_CWD', 'claudeCwd')
  if (!appId) throw new Error('LARK_APP_ID missing. Pass --lark-app-id, set env, or add to ~/.config/clawx/config.json.')
  if (!appSecret) throw new Error('LARK_APP_SECRET missing. Pass --lark-app-secret, set env, or add to ~/.config/clawx/config.json.')
  if (!claudeCwd) throw new Error('CLAUDE_CWD missing. Pass --cwd, set env, or add to ~/.config/clawx/config.json.')
  return {
    appId,
    appSecret,
    claudeCmd: process.env.CLAUDE_CMD?.trim() || fileCfg.claudeCmd || 'claude',
    codexCmd: process.env.CODEX_CMD?.trim() || fileCfg.codexCmd || 'codex',
    claudeCwd,
    claudeTimeoutMs: Number(process.env.CLAUDE_TIMEOUT_MS) || fileCfg.claudeTimeoutMs || 180_000,
    maxQueueSize: Number(process.env.MAX_QUEUE_SIZE) || fileCfg.maxQueueSize || 10,
    instanceId: randomUUID(),
    machineName: process.env.MACHINE_NAME?.trim() || fileCfg.machineName || os.hostname(),
    tmuxThreadChatId:
      process.env.CLAWX_TMUX_THREAD_CHAT_ID?.trim() ||
      (typeof fileCfg.tmuxThreadChatId === 'string' && fileCfg.tmuxThreadChatId.trim()
        ? fileCfg.tmuxThreadChatId.trim()
        : undefined),
    tmuxThreadChats:
      fileCfg.tmuxThreadChats && typeof fileCfg.tmuxThreadChats === 'object'
        ? (fileCfg.tmuxThreadChats as Record<string, string>)
        : undefined,
    tmuxProgressEmoji:
      process.env.CLAWX_TMUX_PROGRESS_EMOJI?.trim() ||
      (typeof fileCfg.tmuxProgressEmoji === 'string' && fileCfg.tmuxProgressEmoji.trim()
        ? fileCfg.tmuxProgressEmoji.trim()
        : undefined),
    userOpenId:
      process.env.CLAWX_USER_OPEN_ID?.trim() ||
      (typeof fileCfg.userOpenId === 'string' && fileCfg.userOpenId.trim()
        ? fileCfg.userOpenId.trim()
        : undefined),
  }
}

interface ExtractedMessage {
  /** Plain user text. Empty for pure-image messages. */
  text: string
  /** image_key values found in the message. For `message_type: 'image'`
   * this is the top-level `image_key`; for `post` with embedded
   * `img` segments it's every embedded key in document order. */
  imageKeys: string[]
}

function extractText(msg: {
  message_type: string
  content: string
}): ExtractedMessage {
  const out: ExtractedMessage = { text: '', imageKeys: [] }
  try {
    const obj = JSON.parse(msg.content) as Record<string, unknown>
    if (msg.message_type === 'text') {
      out.text = String(obj.text ?? '').trim()
      return out
    }
    if (msg.message_type === 'image') {
      // Pure image message: `{"image_key":"img_v3_..."}`. No text body.
      const key = typeof obj.image_key === 'string' ? obj.image_key : ''
      if (key) out.imageKeys.push(key)
      return out
    }
    if (msg.message_type === 'post') {
      // Rich text "post" message — content is a 2D array of segments.
      // Each segment may be {tag:'text', text:'...'}, {tag:'img', image_key:'...'}, etc.
      const blocks = (obj.content as unknown[]) ?? []
      const parts: string[] = []
      for (const line of blocks) {
        if (!Array.isArray(line)) continue
        for (const seg of line as Array<Record<string, unknown>>) {
          if (typeof seg?.text === 'string') parts.push(seg.text)
          if (seg?.tag === 'img' && typeof seg.image_key === 'string') {
            out.imageKeys.push(seg.image_key)
          }
        }
      }
      out.text = parts.join('\n').trim()
      return out
    }
  } catch {
    /* ignore */
  }
  // Fallback: unknown message_type — preserve raw content as text so
  // operators see *something* in logs and can iterate.
  out.text = msg.content
  return out
}

function stripMentions(text: string, mentions?: Array<{ key?: string; name?: string }>): string {
  if (!mentions?.length) return text.trim()
  let out = text
  for (const m of mentions) {
    if (m?.name) out = out.split(`@${m.name}`).join('')
    if (m?.key) out = out.split(m.key).join('')
  }
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * WSClient long-connection entry point. Invoked by `clawx start --ws`.
 * Exported rather than self-running so the CLI dispatcher can pass in
 * flag overrides that take precedence over env + config file.
 */
export async function runWs(overrides: CliOverrides = {}): Promise<void> {
  const cfg = loadWsConfig(overrides)
  log.info('ws-main starting', {
    appId: cfg.appId,
    machineName: cfg.machineName,
    instanceId: cfg.instanceId,
    cwd: cfg.claudeCwd,
  })

  // Match aiden/cli-web's proven setup: no `domain` override (SDK
  // default open.feishu.cn works for internal Lark apps too), no
  // appType. See aiden/cli-web/api/server/services/clawx/index.ts L338.
  const client = new lark.Client({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
  })

  // SessionStore backs the web server + the Stop-hook turn-done lookup
  // (which clawx session owns a given claude UUID). Conversations all
  // go through tmux + Lark threads.
  const sessionsPath =
    process.env.CLAWX_SESSIONS_PATH === ''
      ? undefined
      : process.env.CLAWX_SESSIONS_PATH?.trim() || defaultSessionsPath()
  const sessionStore = new SessionStore({ persistPath: sessionsPath, defaultCwd: cfg.claudeCwd })
  const wsPushSender = new WsPushSender(client)

  // ── tmux mode ──────────────────────────────────────────────────
  // Single store + orchestrator shared between the /new-tmux command
  // handler (below) and the web server's /api/internal/turn-done
  // handler. tmuxThreadChatId may be undefined — /new-tmux will refuse
  // to run in that case, but everything else continues working.
  // Built BEFORE the cron engine so cron's tmux dispatcher can route
  // schedule prompts into a bound session's pane (see startCronEngine
  // call below).
  const tmuxSessionStore = new TmuxSessionStore()
  const larkThread = createLarkThreadService(client)
  const tmuxOrchestrator = createTmuxOrchestrator({
    store: tmuxSessionStore,
    claudeCmd: cfg.claudeCmd,
    codexCmd: cfg.codexCmd,
    // When a routed message gets no turn-start even after an auto-retry,
    // the REPL swallowed it (busy / stuck on a huge context). Warn the
    // user in the session's Lark thread so it isn't a silent drop.
    onDeliveryUnconfirmed: ({ sessionId, text }) => {
      const entry = tmuxSessionStore.get(sessionId)
      if (!entry?.threadId || !entry.rootMessageId) return
      const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text
      void larkThread
        .postInThread({
          rootMessageId: entry.rootMessageId,
          text:
            `⚠️ 上一条消息可能未送达（终端 REPL 繁忙或无响应）：\n` +
            `「${preview}」\n` +
            `已自动补发一次仍无回应——请在终端确认 REPL 状态后重发。`,
        })
        .catch((err: any) => {
          log.warn('tmux delivery warn post failed', {
            sessionId,
            err: err?.message ?? String(err),
          })
        })
    },
  })
  const agentDriver = createAgentDriver({
    claudeCmd: cfg.claudeCmd,
    cwd: cfg.claudeCwd,
  })

  // Backfill the bottom-bar `status-left` + window title for ALL
  // existing sessions on every daemon boot. tmux options reset to
  // defaults across server restarts but the store carries the label
  // (and createdAt for the date stamp) persistently. Sessions without
  // a label fall back to basename(cwd). Fire-and-forget.
  void (async () => {
    for (const entry of tmuxSessionStore.entries()) {
      await tmuxOrchestrator.applyDisplayLabel(entry.sessionId)
    }
  })()

  let cronHandle: ReturnType<typeof startCronEngine> | null = null
  if (process.env.CLAWX_DISABLE_CRON !== '1') {
    cronHandle = startCronEngine({
      pushSender: wsPushSender,
      defaultCwd: cfg.claudeCwd,
      defaultCmd: cfg.claudeCmd,
      promptTimeoutMs: cfg.claudeTimeoutMs,
      // Schedules with tmuxSessionId route through this — payload goes
      // into the live pane, the Stop hook → fanout surfaces the reply
      // in the session's Lark thread. Source 'cli' tags it as a
      // system-driven send (not direct user input).
      tmuxDispatch: async (sessionId, text) => {
        await tmuxOrchestrator.send(sessionId, text, 'cli')
      },
    })
  }

  // Embedded web UI — failures must not block the WS client.
  const webPort = resolveWebPort()
  if (webPort !== null) {
    try {
      const srv = startWebServer({
        port: webPort,
        host: process.env.CLAWX_WEB_HOST?.trim() || undefined,
        sessionStore,
        mode: 'ws',
        instanceId: cfg.instanceId,
        claudeCwd: cfg.claudeCwd,
        cronEngine: cronHandle,
        tmuxSessionStore,
        tmuxOrchestrator,
        larkThread,
        tmuxThreadChatId: cfg.tmuxThreadChatId,
        tmuxThreadChats: cfg.tmuxThreadChats,
        tmuxProgressEmoji: cfg.tmuxProgressEmoji,
        // Callback so freshly-saved openId (auto-discovered on first
        // DM) becomes visible to subsequent create-session calls
        // without a daemon restart.
        userOpenId: () => cfg.userOpenId,
        tmuxFanout: async ({ entry, assistantText }) => {
          if (!entry.threadId || !entry.rootMessageId) return
          if (!assistantText || !assistantText.trim()) return
          // Render the reply as a Lark interactive card so lark_md
          // does the markdown rendering (plain text fanout dropped
          // tables / code blocks). Card kind is inferred from the
          // `🚨` / `⚠️` prefix that turn-done's gather attaches when
          // the turn had API errors:
          //   - "🚨 Claude API 报错 (本轮终止):" → red card
          //   - "⚠️ 本轮经历 N 次 API 错误"     → yellow card
          //   - otherwise                       → blue card
          const trimmed = assistantText.trim()
          const kind: 'error' | 'warning' | 'normal' = trimmed.startsWith('🚨')
            ? 'error'
            : trimmed.startsWith('⚠️')
              ? 'warning'
              : 'normal'
          await postWithRetry(
            (body) =>
              larkThread.postCardInThread({
                rootMessageId: entry.rootMessageId!,
                card: buildBotReplyCard({ text: body, kind }),
              }),
            assistantText,
          )
        },
        // Mid-turn streaming of settled intermediate assistant blocks
        // (opt-in: CLAWX_STREAM_REPLIES). Same blue card as a normal reply.
        tmuxStreamBlock: async ({ entry, text }) => {
          if (!entry.threadId || !entry.rootMessageId || !text.trim()) return
          await postWithRetry(
            (body) =>
              larkThread.postCardInThread({
                rootMessageId: entry.rootMessageId!,
                card: buildBotReplyCard({ text: body, kind: 'normal' }),
              }),
            text,
          )
        },
      })
      srv.on('error', (err) => log.warn('web ui error', { err: err.message }))

      // REPL state watchdog — recovers turns the Stop hook never fired
      // on (error dead-ends, rate-limit / permission dialogs). Polls each
      // in-progress session's pane: warns about a stuck dialog, or
      // replays turn-done so a missed reply still reaches the thread.
      try {
        const watchdog = createReplWatchdog({
          store: tmuxSessionStore,
          capture: (sid) => tmuxOrchestrator.capture(sid, 80),
          postWarning: async (entry, text) => {
            if (!entry.threadId || !entry.rootMessageId) return
            await larkThread.postInThread({
              rootMessageId: entry.rootMessageId,
              text,
            })
          },
          triggerTurnDone: async (entry) => {
            const kind = entry.agentKind ?? 'claude'
            const id = entry.agentSessionId ?? entry.claudeUuid
            if (!id) return
            await postLocalAgentTurnDone(webPort, kind, id, findAgentTranscriptPath(kind, id))
          },
          // Codex has no claude pane UI to read, so the watchdog asks the
          // transcript: does the in-progress turn already have a finished
          // reply (an assistant message past the last turn boundary)? Read
          // the recorded transcriptPath directly to avoid re-scanning all
          // codex jsonl every poll; fall back to a lookup when unset.
          codexHasFinishedReply: async (entry) => {
            const jsonlPath =
              entry.transcriptPath ||
              (entry.agentSessionId
                ? locateCodexSession(entry.agentSessionId)?.jsonlPath
                : undefined)
            if (!jsonlPath) return false
            let raw = ''
            try {
              raw = fs.readFileSync(jsonlPath, 'utf8')
            } catch {
              return false
            }
            const sinceMs =
              (entry.lastTurnAt ? Date.parse(entry.lastTurnAt) : 0) ||
              Date.parse(entry.createdAt) ||
              0
            return readCodexMessagesFromRaw(raw).messages.some(
              (m) =>
                m.role === 'assistant' &&
                m.text.trim() &&
                (Date.parse(m.timestamp) || 0) > sinceMs,
            )
          },
          intervalMs: Number(process.env.CLAWX_REPL_WATCHDOG_MS) || 60_000,
        })
        watchdog.start()
      } catch (err) {
        log.warn('repl-watchdog failed to start', {
          err: err instanceof Error ? err.message : String(err),
        })
      }
    } catch (err) {
      log.warn('web ui failed to start', { err: err instanceof Error ? err.message : String(err) })
    }
  }

  // Idempotency cache for inbound Lark message_id. Lark WSClient
  // redelivers a message_id whenever we don't ACK within ~5s — and our
  // p2p agent path easily takes 5-30s. Keep a sliding window of recent
  // ids so we drop retries cheaply (set membership, O(1)). 10-min TTL
  // is overkill for typical Lark retry policy (~30s) but cheap.
  const seenMessageIds = new Set<string>()
  const seenMessageQueue: Array<{ id: string; at: number }> = []
  const SEEN_TTL_MS = 10 * 60_000
  const SEEN_MAX = 1000
  function rememberMessageId(id: string): void {
    const now = Date.now()
    seenMessageIds.add(id)
    seenMessageQueue.push({ id, at: now })
    // Evict expired / overflow entries from the front.
    while (seenMessageQueue.length > 0) {
      const head = seenMessageQueue[0]!
      if (now - head.at < SEEN_TTL_MS && seenMessageQueue.length <= SEEN_MAX) break
      seenMessageIds.delete(head.id)
      seenMessageQueue.shift()
    }
  }

  const eventDispatcher = new lark.EventDispatcher({}).register({
    // No-op handlers for echo events the bot itself produces. Lark's
    // WSClient otherwise logs `'no im.message.reaction.created_v1 handle'`
    // every time we add/remove a ⏳ reaction, which is noisy and not
    // actionable. Returning {code:0} silences the SDK without otherwise
    // changing behavior.
    'im.message.reaction.created_v1': async () => ({ code: 0 }),
    'im.message.reaction.deleted_v1': async () => ({ code: 0 }),
    'im.message.receive_v1': async (data: any) => {
      const openId = data.sender?.sender_id?.open_id
      const message = data.message
      if (!openId || !message) return { code: 0 }

      // Idempotency on message_id: Lark webhook retries the same event
      // when our handler doesn't ACK within ~5s (the agent-driver path
      // routinely takes 5-30s for claude --print). Without dedup we'd
      // spawn a second agent for the same prompt and the user gets
      // duplicate "🤖 思考中…" + duplicate replies.
      if (seenMessageIds.has(message.message_id)) {
        log.debug('dropping duplicate Lark delivery', {
          messageId: message.message_id,
        })
        return { code: 0 }
      }
      rememberMessageId(message.message_id)

      // Bind the openId to the push sender on first inbound DM so the
      // scheduler can later DM the user without needing a prior task.
      wsPushSender.setUserOpenId(openId)
      // Also persist to ~/.config/clawx/config.json (one-time, idempotent)
      // and update the in-memory cfg so the rest of this session's seed
      // messages can @-mention the user without waiting for the next
      // daemon restart. The persisted value survives restarts.
      if (!cfg.userOpenId) {
        try {
          if (setUserOpenId(openId)) {
            cfg.userOpenId = openId
            log.info('userOpenId auto-saved to config', { openIdPreview: openId.slice(0, 16) })
          }
        } catch (err: any) {
          log.warn('userOpenId persist failed', {
            err: err?.message ?? String(err),
          })
        }
      }

      const extracted = extractText(message)
      const text = stripMentions(extracted.text, message.mentions)
      const imageKeys = extracted.imageKeys
      // Use chat_id as session key so 1:1 DM and group preserve their own context.
      const sessionId = `chat:${message.chat_id}`

      log.task(
        'recv',
        message.message_id.slice(0, 14),
        `chat=${message.chat_id.slice(0, 12)} text="${text.slice(0, 40)}"${
          imageKeys.length ? ` imgs=${imageKeys.length}` : ''
        }`,
      )

      // ── tmux mode: inbound thread routing ──────────────────────
      // If this message arrived inside a thread that maps to one of
      // our tmux sessions, forward it directly to send-keys and skip
      // the rest of the dispatch chain. The Stop hook → turn-done
      // → fanout posts the reply back into the same thread.
      const incomingThreadId =
        (message as { thread_id?: string }).thread_id ?? undefined
      if (incomingThreadId) {
        const entry = tmuxSessionStore.getByThreadId(incomingThreadId)
        if (entry) {
          try {
            // source='lark' — this text was typed in the thread itself,
            // so it's ALREADY visible there. Tell the orchestrator so
            // turn-done's fanout doesn't echo it back as a duplicate.
            // Also stash the inbound message_id so PreToolUse can ⏳-
            // react to the user's actual message (cleared at turn-done).
            // Control word: a bare lowercase "esc" maps to the Escape KEY
            // (interrupt the current generation / cancel a prompt) rather
            // than being typed as literal text — lets the user abort a
            // runaway turn from Lark. Strict lowercase + no attachments so
            // it can't swallow a real message that merely says "esc".
            if (text.trim() === 'esc' && imageKeys.length === 0) {
              await tmuxOrchestrator.interrupt(entry.sessionId)
              log.info('tmux thread message -> ESC (interrupt)', {
                sessionId: entry.sessionId,
                threadId: incomingThreadId,
              })
              if (entry.threadId && entry.rootMessageId) {
                await larkThread
                  .postInThread({
                    rootMessageId: entry.rootMessageId,
                    text: `⎋ 已发送中断键（${entry.agentKind === 'codex' ? 'Ctrl-C' : 'Esc'}）`,
                  })
                  .catch(() => {})
              }
              return
            }

            tmuxSessionStore.patch(entry.sessionId, {
              currentTurnUserMessageId: message.message_id,
              currentTurnReactionId: undefined,
            })

            // Image attachments: download each → reference with @path
            // syntax that Claude Code's REPL natively understands (it
            // reads the file and feeds the bytes to the model as part
            // of the user turn). We prepend the @path tokens so the
            // human-readable text follows, mirroring how someone would
            // type `@img.jpg 看一下` in the REPL by hand.
            const imagePaths: string[] = []
            for (let i = 0; i < imageKeys.length; i++) {
              try {
                const p = await downloadMessageResource({
                  client,
                  messageId: message.message_id,
                  fileKey: imageKeys[i]!,
                  type: 'image',
                  filename: `${message.message_id}-${i}.jpg`,
                })
                imagePaths.push(p)
              } catch (err: any) {
                log.warn('lark image download failed', {
                  sessionId: entry.sessionId,
                  fileKey: imageKeys[i],
                  err: err?.message ?? String(err),
                })
              }
            }
            const sendText = [
              ...imagePaths.map((p) => `@${p}`),
              text,
            ]
              .filter((s) => s.trim())
              .join(' ')

            await tmuxOrchestrator.send(entry.sessionId, sendText, 'lark')
            log.info('tmux thread message → send-keys', {
              sessionId: entry.sessionId,
              threadId: incomingThreadId,
              textPreview: text.slice(0, 60),
              imageCount: imagePaths.length,
            })
          } catch (err: any) {
            await replyText(
              client,
              message.message_id,
              `✗ tmux 发送失败: ${err?.message ?? String(err)}`,
            )
          }
          return { code: 0 }
        }
      }

      // ── tmux mode: /new-tmux <cwd> command ────────────────────
      // Creates a new tmux session, opens a Lark thread for it, and
      // tells the user how to attach. Handled before manager/meta so
      // the prefix is reserved.
      const newTmuxMatch = text.trim().match(/^\/new-tmux(?:\s+(.+))?$/i)
      if (newTmuxMatch) {
        // Parse "cwd [title...]" — first whitespace-token is the cwd,
        // everything after is the optional title shown in the Lark
        // thread seed message. cwd alone is still valid (no title).
        const rest = newTmuxMatch[1]?.trim() ?? ''
        const firstWs = rest.search(/\s/)
        const cwdArg = firstWs === -1 ? rest : rest.slice(0, firstWs)
        const labelArg = firstWs === -1 ? '' : rest.slice(firstWs + 1).trim()
        const reply = await handleNewTmuxCommand({
          arg: cwdArg,
          label: labelArg || undefined,
          defaultCwd: cfg.claudeCwd,
          chatId: cfg.tmuxThreadChatId,
          orchestrator: tmuxOrchestrator,
          store: tmuxSessionStore,
          larkThread,
          // The /new-tmux command is itself a DM, so we KNOW the
          // sender's open_id — use it directly even if cfg hasn't
          // been populated yet from a prior auto-discovery.
          mentionOpenId: cfg.userOpenId || openId,
        })
        await replyText(client, message.message_id, reply)
        return { code: 0 }
      }

      // Anything that reaches here is a non-thread, non-/new-tmux DM.
      // Branch on chat type:
      //   - p2p (1-on-1 DM): hand off to the persistent ops agent
      //   - group: don't go conversational — point at /new-tmux so the
      //     bot doesn't become a noisy chitchat machine in shared chats
      const chatType = (message as { chat_type?: string }).chat_type
      if (chatType === 'p2p') {
        // Fire-and-forget so the handler ACKs the Lark webhook FAST.
        // claude --print easily takes 5-30s; the receive_v1 handler's
        // return value IS the ACK, and Lark retries any event we don't
        // ACK within ~5s. Without this offloading we'd ALWAYS hit the
        // retry window for non-trivial prompts. (Dedup at the top of
        // this handler catches retries that still slip through.)
        //
        // "Working on it" indicator: add a 🤔 reaction to the user's
        // DM (instead of posting a "思考中…" text message, which is
        // visually noisy + duplicates on retries). Reaction goes away
        // when the real reply lands.
        const progressEmoji = cfg.tmuxProgressEmoji?.trim() || 'THINKING'
        let progressReactionId: string | null = null
        void (async () => {
          try {
            const r = await larkThread.addReaction({
              messageId: message.message_id,
              emojiType: progressEmoji,
            })
            progressReactionId = r.reactionId
          } catch (err: any) {
            // Non-fatal — operator just won't see the 🤔.
            log.debug('agent DM: reaction add failed', {
              err: err?.message ?? String(err),
            })
          }
        })()
        void (async () => {
          try {
            const reply = await agentDriver.handle(text)
            await replyText(client, message.message_id, reply || '(agent 返回为空)')
          } catch (err: any) {
            log.warn('agent DM failed', {
              chatId: message.chat_id,
              err: err?.message ?? String(err),
            })
            await replyText(
              client,
              message.message_id,
              `✗ agent 出错: ${err?.message ?? String(err)}`,
            )
          } finally {
            // Clear the 🤔 once we've posted (success or error). If the
            // reaction add raced past us (still in-flight), best effort
            // — the small delay before clear is acceptable.
            if (progressReactionId) {
              try {
                await larkThread.removeReaction({
                  messageId: message.message_id,
                  reactionId: progressReactionId,
                })
              } catch {
                /* tolerate — leftover 🤔 is harmless */
              }
            }
          }
        })()
        return { code: 0 }
      }

      // Group / supergroup — keep the simple hint to avoid noise.
      log.task(
        'idle',
        message.message_id.slice(0, 14),
        `chat=${message.chat_id.slice(0, 12)} group unmatched text="${text.slice(0, 40)}"`,
      )
      await replyText(
        client,
        message.message_id,
        '💡 这里只接受 `/new-tmux <项目路径>` 命令。需要自然语言操作（创建/查询/清理 session）请 DM 我。',
      )
      return { code: 0 }
    },
  })

  const wsClient = new lark.WSClient({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    loggerLevel: lark.LoggerLevel.debug,
  })
  await wsClient.start({ eventDispatcher })

  log.info('WSClient started — waiting for Lark events')

  const shutdown = (sig: string): void => {
    log.warn(`${sig}, shutting down`)
    cronHandle?.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

async function replyText(
  client: lark.Client,
  messageId: string,
  text: string,
): Promise<void> {
  try {
    await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    })
  } catch (err) {
    log.error('lark reply failed', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}


/**
 * Handle `/new-tmux [cwd]` in the WS message stream. Spawns a tmux
 * session, opens a Lark thread for it, and returns the user-facing
 * reply (markdown text with attach instructions + thread link).
 *
 * Failure modes:
 *   - tmuxThreadChatId not configured → return an error message; the
 *     user can still use the web API directly (no thread).
 *   - tmux create or Lark thread create fails → tear down the tmux
 *     session so we don't leave orphans in the store.
 */
async function handleNewTmuxCommand(opts: {
  arg: string
  /** Optional human-readable title — first line of the Lark thread
   * seed message. Parsed from anything after the cwd in /new-tmux. */
  label?: string
  defaultCwd: string
  chatId: string | undefined
  orchestrator: import('./tmux-orchestrator.js').TmuxOrchestrator
  store: import('./tmux-session-store.js').TmuxSessionStore
  larkThread: import('./lark-thread.js').LarkThreadService
  /** Operator's open_id for the seed @-mention. /new-tmux is always
   * triggered by an actual Lark message, so the user is sitting at
   * their phone and pings double as "subscribe me to this thread". */
  mentionOpenId?: string
}): Promise<string> {
  if (!opts.chatId) {
    return (
      '✗ `/new-tmux` 未启用: 没配 `tmuxThreadChatId`。\n' +
      '在 `~/.config/clawx/config.json` 加 `"tmuxThreadChatId": "oc_..."`，' +
      '或设环境变量 `CLAWX_TMUX_THREAD_CHAT_ID`，重启后生效。'
    )
  }
  const cwd = opts.arg || opts.defaultCwd
  const sessionId = `tmux-${Math.random().toString(16).slice(2, 10)}`

  // 1. tmux + claude REPL up.
  let entry
  try {
    entry = await opts.orchestrator.create({ sessionId, cwd, label: opts.label })
  } catch (err: any) {
    return `✗ tmux 创建失败: ${err?.message ?? String(err)}`
  }

  // 2. open thread. On failure, tear down the tmux so we don't leak.
  let thread
  try {
    thread = await opts.larkThread.createThread({
      chatId: opts.chatId,
      seedText: formatSeedText({
        cwd,
        sessionId,
        tmuxName: entry.tmuxName,
        claudeUuid: entry.claudeUuid,
        agentKind: entry.agentKind,
        agentSessionId: entry.agentSessionId,
        label: opts.label,
        creator: 'lark',
        mentionOpenId: opts.mentionOpenId,
      }),
    })
  } catch (err: any) {
    try {
      await opts.orchestrator.kill(sessionId)
    } catch {
      /* ignore — best-effort cleanup */
    }
    return `✗ Lark 话题创建失败: ${err?.message ?? String(err)}`
  }

  // 3. record the thread metadata so turn-done can fan out + inbound
  //    messages route correctly.
  opts.store.patch(sessionId, {
    threadId: thread.threadId,
    chatId: opts.chatId,
    rootMessageId: thread.rootMessageId,
  })

  log.info('new-tmux: session + thread ready', {
    sessionId,
    threadId: thread.threadId,
    cwd,
  })

  return [
    `✓ tmux session 已就绪`,
    ``,
    `**会话 ID**: \`${sessionId}\``,
    `**tmux 名**: \`${entry.tmuxName}\``,
    `**cwd**: \`${cwd}\``,
    ``,
    `**终端 attach**: \`tmux attach -t ${entry.tmuxName}\``,
    `**话题已建好**, 直接在话题里发消息即可继续对话。`,
    `${entry.agentKind === 'codex' ? 'Codex' : 'Claude'} 答完一轮会自动回到话题里。`,
  ].join('\n')
}
