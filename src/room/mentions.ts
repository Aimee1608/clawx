// Literal "@name" tokens → real Feishu <at> tags, plus small text helpers.
//
// Ground truth from scripts/at-render-probe.ts (2026-06-11):
//   - TEXT / v1-card lark_md / post: <at user_id="ou_..."> is registered
//     server-side (message.mentions) AND rendered — for users and bots,
//     even with an open_id from another app's scope (server canonicalizes).
//   - v2 CARD (schema 2.0): at-tags are never registered server-side (no
//     notification semantics), but inside a div/lark_md element the CLIENT
//     still renders the blue mention chip. Per the user's call, blue chips
//     are all we need — so cards are uniformly v2 and lines
//     containing @tokens are split into div/lark_md segments (splitForCard).
import type { LarkAppsConfig } from './lark-multi.js'

export interface MentionTarget {
  /** literal token matched after '@' (e.g. "Forge主案", "主案", "proposer") */
  token: string
  at: string
  isUser: boolean
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function userAtTag(cfg: LarkAppsConfig): string | null {
  if (!cfg.userOpenId) return null
  return `<at user_id="${cfg.userOpenId}">${cfg.userName ?? '用户'}</at>`
}

/** Build the replacement table: user aliases + every member's display /
 * short / role name. Longest token first so "@Forge主案" wins over "@主案". */
export function buildMentionTargets(cfg: LarkAppsConfig): MentionTarget[] {
  const out: MentionTarget[] = []
  const uat = userAtTag(cfg)
  if (uat) {
    const aliases = new Set([cfg.userName ?? '', ...(cfg.userAliases ?? []), '用户'])
    for (const a of aliases) if (a) out.push({ token: a, at: uat, isUser: true })
  }
  for (const [member, appKey] of Object.entries(cfg.roleMap)) {
    const oid = cfg.botOpenIds?.[appKey]
    if (!oid) continue
    const display = cfg.apps[appKey]?.name ?? member
    const at = `<at user_id="${oid}">${display}</at>`
    const tokens = new Set([display, display.replace(/^Forge/i, ''), member])
    for (const t of tokens) if (t) out.push({ token: t, at, isUser: false })
  }
  out.sort((a, b) => b.token.length - a.token.length)
  return out
}

/** Replace literal "@token" occurrences with real at tags. */
export function atify(
  text: string,
  targets: MentionTarget[],
): { out: string; mentionedUser: boolean } {
  let out = text
  let mentionedUser = false
  for (const t of targets) {
    const re = new RegExp(`@${escapeRegex(t.token)}`, 'g')
    if (!re.test(out)) continue
    out = out.replace(re, t.at)
    if (t.isUser) mentionedUser = true
  }
  return { out, mentionedUser }
}

export interface CardSegment {
  /** 'md' renders in a v2 markdown element (full markdown, at not blue);
   * 'at' renders in a div/lark_md element (blue mention chips). */
  kind: 'md' | 'at'
  text: string
}

/** Split a card body into markdown / lark_md segments so that every line
 * containing an @token gets blue mention chips while tables, code blocks
 * and everything else keep the full v2 markdown surface. */
export function splitForCard(
  text: string,
  targets: MentionTarget[],
): { segments: CardSegment[]; mentionedUser: boolean } {
  const segments: CardSegment[] = []
  let mentionedUser = false
  let md: string[] = []
  let inCode = false
  const flush = (): void => {
    if (md.length > 0) {
      segments.push({ kind: 'md', text: md.join('\n') })
      md = []
    }
  }
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inCode = !inCode
      md.push(line)
      continue
    }
    // Table rows must stay inside one markdown element or the table tears.
    if (inCode || line.trimStart().startsWith('|')) {
      md.push(line)
      continue
    }
    const r = atify(line, targets)
    if (r.out === line) {
      md.push(line)
      continue
    }
    flush()
    segments.push({ kind: 'at', text: r.out })
    if (r.mentionedUser) mentionedUser = true
  }
  flush()
  return { segments, mentionedUser }
}

/** Does this content explicitly call for the user's attention?
 * Matches the configured Feishu name plus the generic "@用户" marker. */
export function wantsUser(text: string, userName: string): boolean {
  const n = escapeRegex(userName)
  return new RegExp(`@${n}|【待\\s*${n}|@用户`, 'i').test(text)
}
