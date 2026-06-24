import path from 'node:path'

import type { AgentKind } from './agent-backend.js'
import type { SendSource } from './tmux-orchestrator.js'

export interface AskQuestionItem {
  question: string
  header?: string
  options?: Array<{ label?: string; description?: string }>
  multiSelect?: boolean
}

/**
 * Build a Lark interactive card that surfaces a claude AskUserQuestion
 * tool call that we just blocked. The user sees what claude *wanted*
 * to ask, and knows claude will retry inline so they can reply
 * normally in the thread.
 *
 * Multiple questions in one call → numbered sections. Options listed
 * as a markdown bullet list. Long content is truncated for safety.
 */
export function buildAskQuestionCard(args: {
  questions: AskQuestionItem[]
}): Record<string, unknown> {
  const lines: string[] = []
  const list = args.questions ?? []
  if (list.length === 0) {
    lines.push('_(empty AskUserQuestion payload)_')
  } else {
    list.forEach((q, i) => {
      const prefix = list.length > 1 ? `**${i + 1}. ${q.header ?? '问题'}** — ` : ''
      lines.push(`${prefix}${q.question || '(no question text)'}`)
      if (Array.isArray(q.options) && q.options.length > 0) {
        for (const o of q.options) {
          const label = o.label ?? ''
          const desc = o.description ? ` — ${o.description}` : ''
          lines.push(`- ${label}${desc}`)
        }
      }
      if (q.multiSelect) lines.push('_(multi-select)_')
      if (i < list.length - 1) lines.push('')
    })
  }
  lines.push('')
  lines.push('_claude 正在用 inline 文字重新提问，你直接在话题里文字回复就好。_')
  const body = lines.join('\n').slice(0, 4000)
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '🤔 Claude 想问你' },
      template: 'yellow',
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: body },
      },
    ],
  }
}

/**
 * Build a Lark interactive card that represents a user input forwarded
 * from somewhere else (web composer / cli / terminal / lark thread).
 * Renders as a titled box in the thread so the operator can scan
 * input vs assistant reply at a glance.
 *
 * Wrapped in plain_text/lark_md elements; the body is escaped enough
 * (multi-byte and `>` quoting handled by lark_md). Long inputs are
 * truncated to 2000 chars to keep card payloads manageable.
 */
/**
 * Build a Lark interactive card (v2 schema) for the bot's fanout reply.
 *
 * Uses card v2 (`schema: '2.0'`) with the `markdown` element, which
 * supports the full markdown surface: headings, tables, lists, code
 * blocks, quotes, bold/italic/strike, links. The v1 schema + `lark_md`
 * inline tag we used initially only renders `**bold** *italic* code
 * link` — tables and lists fell through as raw text.
 *
 * `kind`:
 *   - 'normal' (default) → blue header
 *   - 'warning' → yellow header (used when the turn had recovered errors)
 *   - 'error'   → red header (used when the turn dead-ended on an error)
 */
export function buildBotReplyCard(args: {
  text: string
  kind?: 'normal' | 'warning' | 'error'
  /** Mid-turn streamed block (not the final answer). Renders a turquoise
   * card with a 💭 header so the thread visibly separates "process" blocks
   * from the final blue reply that lands at turn-done. */
  intermediate?: boolean
}): Record<string, unknown> {
  const kind = args.kind ?? 'normal'
  // First non-empty line, stripped of leading markdown markers and
  // emoji prefixes that already convey "error/warning" since the card
  // template carries that color signal.
  const firstLine =
    args.text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '(空回复)'
  let title = firstLine
    .replace(/^#{1,6}\s+/, '') // markdown headings
    .replace(/^[*\-+]\s+/, '') // bullet markers
    .replace(/^\*\*(.+?)\*\*$/, '$1') // surrounding bold
    .trim()
  if (kind === 'error') title = title.replace(/^🚨\s*/, '')
  if (kind === 'warning') title = title.replace(/^⚠️\s*/, '')
  if (title.length > 80) title = title.slice(0, 77) + '…'
  if (!title) {
    title =
      kind === 'error' ? 'Claude 报错' : kind === 'warning' ? 'Claude 回复 (含警告)' : 'Claude 回复'
  }
  // Mid-turn block: mark it visibly as "process" so it never reads as the
  // final answer. Prefix the header and (below) recolor the card to turquoise.
  if (args.intermediate) title = `💭 ${title}`
  // v2 markdown handles standard markdown directly — DO NOT do the
  // single-\n → double-\n transformation we needed for v1 lark_md;
  // doing so would inject blank rows into tables and break list flow.
  const body =
    args.text.length > 8000
      ? `${args.text.slice(0, 8000)}\n\n…（已截断 ${args.text.length - 8000} 字符）`
      : args.text
  const template = args.intermediate
    ? 'turquoise'
    : kind === 'error'
      ? 'red'
      : kind === 'warning'
        ? 'yellow'
        : 'blue'
  return {
    schema: '2.0',
    header: {
      title: { tag: 'plain_text', content: title },
      template,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: body,
        },
      ],
    },
  }
}

export function buildForwardCard(args: {
  source: SendSource | 'unknown'
  text: string
}): Record<string, unknown> {
  const cap = 2000
  let body =
    args.text.length > cap
      ? `${args.text.slice(0, cap)}\n\n…（已截断 ${args.text.length - cap} 字符）`
      : args.text
  // lark_md is Markdown-rendered: a single `\n` is treated as a soft
  // line break and collapses to a space, so multi-line user input
  // would render as one long blob. Convert each single `\n` to a
  // paragraph break (`\n\n`) so line structure survives. We
  // deliberately avoid collapsing existing `\n\n` runs by only
  // doubling lone newlines.
  body = body.replace(/([^\n])\n([^\n])/g, '$1\n\n$2')
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🖥 转发自 ${sourceLabel(args.source)}` },
      template: 'blue',
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: body },
      },
    ],
  }
}

/** Human-readable label per send source — used in seed text + reaction
 * tagging. Kept here (not in web.ts) so non-web call sites (e.g. the
 * Lark /new-tmux command handler) can render the same surface. */
export function sourceLabel(s: SendSource | 'unknown'): string {
  switch (s) {
    case 'web':
      return 'web'
    case 'cli':
      return '终端 (clawx tmux)'
    case 'lark':
      return 'Lark'
    case 'terminal':
      return '终端 (直敲)'
    default:
      return '未知'
  }
}

export interface FormatSeedTextArgs {
  cwd: string
  sessionId: string
  claudeUuid?: string
  agentKind?: AgentKind
  agentSessionId?: string
  /** Short user-supplied title; takes precedence over basename(cwd) as
   * the first line of the seed message. */
  label?: string
  creator: SendSource | 'unknown'
  resumed?: boolean
  /** tmux session name (the orchestrator-assigned `clawx-<slug>` —
   * what `tmux attach -t` expects). When omitted we synthesize the
   * default `clawx-<sessionId>` since that's the orchestrator's
   * naming convention. */
  tmuxName?: string
  /** Operator's Lark open_id. When provided, the seed message starts
   * with an `<at user_id="ou_...">` tag so Lark auto-subscribes the
   * user to the new topic and pings them on creation. Without this,
   * the topic gets created but the user won't receive notifications
   * for subsequent messages until they manually subscribe. */
  mentionOpenId?: string
}

/**
 * Compose the seed message that anchors a new Lark thread.
 *
 * Goal: when there are many sessions in the group, the user can scan
 * the topic list and tell sessions apart at a glance. The first line
 * is the "title" — user-supplied `label` takes precedence, otherwise
 * basename(cwd). Second line is the creation timestamp in
 * Asia/Shanghai (operator-friendly). Third + fourth lines carry the
 * cwd full path and the sid / full claude uuid for grep / debug.
 */
export function formatSeedText(args: FormatSeedTextArgs): string {
  const basename = path.basename(args.cwd) || args.cwd
  const title = args.label?.trim() || basename
  const icon = args.resumed ? '♻️' : '🆕'
  const resumeTag = args.resumed ? '续接' : ''
  const createdAtCN = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(new Date())
    .replace(',', '')
  const agentKind = args.agentKind ?? 'claude'
  const fullUuid = args.agentSessionId ?? args.claudeUuid ?? '(pending)'
  const tagBits = [sourceLabel(args.creator), resumeTag].filter(Boolean)
  const tmuxName = args.tmuxName ?? `clawx-${args.sessionId}`
  // @-mention the operator so Lark auto-subscribes them to this new
  // topic. Without this, default Lark behavior is "topic created but
  // I'm not in it until I explicitly join", which means no push
  // notifications for subsequent messages. Tag goes on its own line
  // at the END so the human-readable title + metadata is what catches
  // the eye when scanning the topic list, and the @ is a quieter ping.
  const mentionLine = args.mentionOpenId?.trim()
    ? `\n<at user_id="${args.mentionOpenId.trim()}"></at>`
    : ''
  return (
    [
      `${icon} ${title}`,
      '',
      `🕒 ${createdAtCN} CST · 来自 ${tagBits.join(' · ')}`,
      `📁 ${args.cwd}`,
      `💻 终端打开: tmux attach -t ${tmuxName}`,
      `🆔 sid: ${args.sessionId}`,
      `🤖 agent: ${agentKind}`,
      `${agentKind}: ${fullUuid}`,
    ].join('\n') + mentionLine
  )
}
