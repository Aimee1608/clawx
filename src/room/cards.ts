// Lark interactive cards for the room bridge.
// Adapted from clawbot-hub src/seed-text.ts buildBotReplyCard @ a73086f,
// then evolved on probe evidence (scripts/at-render-probe.ts):
//   - Every card is v2 (schema 2.0). The body is a SEGMENT LIST: plain
//     segments render in a `markdown` element (tables, code blocks, full
//     surface); lines carrying @tokens render in a `div`/`lark_md` element,
//     where the client paints real blue mention chips. v2 never registers
//     mentions server-side (no notification), which is fine — per the
//     user's call the chips are for visual scanning, not for pinging.
//   - Title derived from summary / first line, markdown markers stripped.
//   - 8000-char body cap with an explicit truncation marker (capBody —
//     callers cap BEFORE splitting into segments).

import type { CardSegment } from './mentions.js'

const BODY_CAP = 8000

/** Fixed header color per member so the speaker is recognizable even
 * before reading the bot name. */
const MEMBER_COLORS: Record<string, string> = {
  'team-lead': 'purple',
  proposer: 'blue',
  challenger: 'green',
}

export function deriveCardTitle(summary: string, body: string, fallback: string): string {
  let t = summary.trim()
  if (!t) {
    t =
      body
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? ''
  }
  t = t
    .replace(/^#{1,6}\s+/, '') // markdown headings
    .replace(/^[*\-+]\s+/, '') // bullet markers
    .replace(/^\*\*(.+?)\*\*$/, '$1') // surrounding bold
    .trim()
  if (t.length > 80) t = t.slice(0, 77) + '…'
  return t || fallback
}

export function capBody(text: string): string {
  return text.length > BODY_CAP
    ? `${text.slice(0, BODY_CAP)}\n\n…（已截断 ${text.length - BODY_CAP} 字符）`
    : text
}

/** A v2 card whose body mixes markdown elements with lark_md mention
 * lines. Header color identifies the speaking member. */
export function buildRichCard(args: {
  from: string
  title: string
  subtitle?: string
  segments: CardSegment[]
}): Record<string, unknown> {
  const template = MEMBER_COLORS[args.from.replace(/-\d+$/, '')] ?? 'grey'
  const header: Record<string, unknown> = {
    title: { tag: 'plain_text', content: args.title },
    template,
  }
  if (args.subtitle) header.subtitle = { tag: 'plain_text', content: args.subtitle }
  const elements = args.segments.map((seg) =>
    seg.kind === 'at'
      ? { tag: 'div', text: { tag: 'lark_md', content: seg.text } }
      : { tag: 'markdown', content: seg.text },
  )
  return {
    schema: '2.0',
    header,
    body: { elements },
  }
}
