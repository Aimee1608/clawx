import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import http from 'node:http'

/**
 * MCP stdio server bundled into `clawx agent-mcp-server`. Spawned by
 * the `claude --mcp-config` subprocess that the agent driver fires for
 * each DM. Exposes a small set of "tmux session ops" tools so the
 * agent can answer asks like "list my sessions", "kill the migrate-tools
 * one", "create a new session under markone-moltbot" in natural
 * language.
 *
 * Architecture: each tool here is a thin shell around the same HTTP
 * routes the web UI uses. That keeps the surface narrow and reuses
 * the daemon's already-tested logic (orchestrator + lark-thread + store).
 *
 * Why HTTP instead of importing modules in-process: the MCP server
 * runs as a SUBPROCESS of claude, started fresh per agent turn. It
 * has no shared memory with the daemon. Going through the daemon's
 * HTTP API is the simplest cross-process boundary; localhost calls
 * are sub-ms.
 */

const SERVER_NAME = 'clawx-ops'
const SERVER_VERSION = '0.1.0'

interface DaemonConfig {
  host: string
  port: number
}

function daemonConfig(): DaemonConfig {
  return {
    host: '127.0.0.1',
    port: Number(process.env.CLAWX_WEB_PORT) || 8124,
  }
}

async function daemonRequest<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const cfg = daemonConfig()
  const payload = body ? JSON.stringify(body) : undefined
  return new Promise<T>((resolve, reject) => {
    const req = http.request(
      {
        host: cfg.host,
        port: cfg.port,
        path,
        method,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {},
        timeout: 30_000,
      },
      (res) => {
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (buf += c))
        res.on('end', () => {
          try {
            const parsed = buf ? JSON.parse(buf) : null
            resolve(parsed as T)
          } catch (err) {
            reject(new Error(`daemon ${method} ${path}: bad JSON ${buf.slice(0, 200)}`))
          }
        })
      },
    )
    req.on('error', (err) =>
      reject(new Error(`daemon ${method} ${path}: ${err.message}`)),
    )
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`daemon ${method} ${path}: timeout`))
    })
    if (payload) req.write(payload)
    req.end()
  })
}

function textResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [
      {
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
  }
}

export function createAgentMcpServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  )

  // ── list_tmux_sessions ──────────────────────────────────────
  server.tool(
    'list_tmux_sessions',
    'Return every tmux session clawx is tracking on this host. Each ' +
      'entry includes sessionId (sid), tmuxName (for `tmux attach`), cwd, ' +
      'claudeUuid, optional threadId (Lark), createdAt, lastTurnAt. ' +
      'Use this when the user asks "what sessions do I have", "show me the running ones", "any active session for markone", etc.',
    {},
    async () => {
      const data = await daemonRequest<{ sessions: unknown[] }>(
        'GET',
        '/api/tmux-sessions',
      )
      return textResult(data)
    },
  )

  // ── create_tmux_session ─────────────────────────────────────
  server.tool(
    'create_tmux_session',
    'Spawn a new tmux + claude REPL bound to a given cwd. Auto-creates ' +
      'a Lark thread when the daemon has `tmuxThreadChatId` configured. ' +
      'Use when the user says "create a session for X", "起一个 X 的会话", ' +
      '"开个 migrate-tools 的". ' +
      'BEHAVIOR — before calling this tool, ASK the user for a short ' +
      'descriptive title (the `label` argument). The seed message in ' +
      'Lark thread uses that as the topic name and the user will rely ' +
      'on it to tell sessions apart later. If they decline, fall back ' +
      'to a sensible default like "<basename> 调研" or skip the label.',
    {
      cwd: z
        .string()
        .min(1)
        .describe('Absolute filesystem path for the claude REPL\'s working directory.'),
      label: z
        .string()
        .optional()
        .describe(
          'Short human-readable title for the session. Becomes the topic ' +
            'name in the Lark thread seed message (e.g. "dashboard SSO 调研" ' +
            'or "agent-monorepo 重构方案"). Strongly recommended — long-lived ' +
            "sessions are hard to distinguish without one. Ask the user if " +
            'they didn\'t provide one.',
        ),
      group: z
        .string()
        .optional()
        .describe(
          'Optional named topic group (resolved against config ' +
            '`tmuxThreadChats`) that routes the Lark thread to a non-default ' +
            'chat. Omit to land in the default tmux group chat. Use when ' +
            'the user explicitly names a group, e.g. "group is life" / ' +
            '"放到 X 这个 group / 分组".',
        ),
    },
    async ({ cwd, label, group }) => {
      const data = await daemonRequest<unknown>('POST', '/api/tmux-sessions', {
        cwd,
        label,
        group,
        source: 'cli', // surfaces as "来自 终端 (clawx tmux)" in seed
      })
      return textResult(data)
    },
  )

  // ── kill_tmux_session ───────────────────────────────────────
  server.tool(
    'kill_tmux_session',
    'Tear down a tmux session and drop it from the store. DESTRUCTIVE: ' +
      'a running tmux + claude REPL is killed and any in-flight work is lost. ' +
      'STRICT POLICY — never call on the first turn the user mentions kill / ' +
      'cleanup / 清理 / 砍 / 杀. Instead: (1) call list_tmux_sessions and ' +
      'echo the candidate sid + cwd + lastTurnAt back to the user; (2) ask ' +
      'the user to **retype the full sid verbatim**; (3) only on a turn ' +
      'where the user has retyped that exact sid in their message may you ' +
      'invoke this tool. "yes/ok/confirm" is NOT sufficient — guard against ' +
      'crossed wires.',
    {
      sessionId: z
        .string()
        .min(1)
        .describe('clawx session id (e.g. "tmux-abc12345" or "cli-tmux-...")'),
    },
    async ({ sessionId }) => {
      const data = await daemonRequest<unknown>(
        'DELETE',
        `/api/tmux-sessions/${encodeURIComponent(sessionId)}`,
      )
      return textResult({ killed: sessionId, response: data })
    },
  )

  // ── send_to_tmux_session ────────────────────────────────────
  server.tool(
    'send_to_tmux_session',
    "Forward a text prompt to an existing tmux session's claude REPL. " +
      "The session's claude will process it and produce a response in " +
      "its own thread / pane (NOT in this agent\'s reply). Use sparingly " +
      "— only when the user explicitly asks to send a message to another " +
      'session.',
    {
      sessionId: z.string().min(1).describe('clawx session id'),
      text: z.string().min(1).describe('Text to type into the pane'),
    },
    async ({ sessionId, text }) => {
      const data = await daemonRequest<unknown>(
        'POST',
        `/api/tmux-sessions/${encodeURIComponent(sessionId)}/send`,
        { text, source: 'cli' },
      )
      return textResult({ sent: { sessionId, textPreview: text.slice(0, 80) }, response: data })
    },
  )

  // ── capture_tmux_pane ───────────────────────────────────────
  server.tool(
    'capture_tmux_pane',
    'Snapshot the current tmux pane content (last few hundred lines). ' +
      'Useful when the user asks "what is session X doing right now", ' +
      '"X 那个 session 跑到哪了". Don\'t dump the full output verbatim ' +
      'back to the user — summarize the interesting bits.',
    {
      sessionId: z.string().min(1),
    },
    async ({ sessionId }) => {
      const data = await daemonRequest<{ ok: boolean; text?: string; error?: string }>(
        'GET',
        `/api/tmux-sessions/${encodeURIComponent(sessionId)}/capture`,
      )
      return textResult(data)
    },
  )

  // ── list_cwd_suggestions ────────────────────────────────────
  server.tool(
    'list_cwd_suggestions',
    "Return the daemon's curated list of candidate project paths: " +
      "user-pinned favorites first, then scanned children of " +
      '~/workspace, then recent. Useful before creating a ' +
      'session — pick the right cwd when the user is vague ("起一个 markone 的").',
    {},
    async () => {
      const data = await daemonRequest<unknown>('GET', '/api/cwd-suggestions')
      return textResult(data)
    },
  )

  return server
}

export async function runAgentMcpServer(): Promise<void> {
  const server = createAgentMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
