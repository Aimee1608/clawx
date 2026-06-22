// The Feishu bridge: the only piece we own. Mirrors the team's mailbox
// traffic into Feishu, routes the user's messages back into tmux panes,
// and watches for convergence. Per-room foreground process — no daemon,
// no long connection, no hooks.
//
// One surface: topic — one topic per room in a topic group; each agent
// speaks through its own Feishu app (real multi-bot identities).
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'

import { log } from '../logger.js'
import { loadLarkApps, saveUserOpenId, LarkFleet } from './lark-multi.js'
import { buildRichCard, deriveCardTitle, capBody } from './cards.js'
import { buildMentionTargets, atify, splitForCard, wantsUser, userAtTag } from './mentions.js'
import type { RoomState } from './types.js'
import { saveRoom, bridgeLockPath, readBridgeLockPid } from './room-store.js'
import { findTeam, projectDirForCwd, listSessionJsonls } from './teams.js'
import {
  readNewEvents,
  firstUserText,
  type MailboxEvent,
  type AssistantTextEvent,
} from './jsonl-watch.js'
import { runCodexReview } from './codex-review.js'

const execFileP = promisify(execFile)
const TICK_MS = 3000
const MAX_MSG_CHARS = 1800
/** Cap how many times codex may bounce a convergence back for re-debate,
 * so a stubborn disagreement can't loop the room forever. */
const CODEX_MAX_ROUNDS = 2

async function tmux(...args: string[]): Promise<void> {
  await execFileP('tmux', args)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function clip(s: string, n = MAX_MSG_CHARS): string {
  return s.length > n ? s.slice(0, n) + '\n…(截断)' : s
}

async function sendKeysTo(paneId: string, text: string): Promise<void> {
  // Literal text, then Enter. The REPL queues type-ahead if busy.
  await tmux('send-keys', '-t', paneId, '-l', text.replace(/\n/g, ' '))
  await sleep(300)
  await tmux('send-keys', '-t', paneId, 'Enter')
  // clawx-style nudge: the first Enter occasionally lands while the REPL
  // is mid-render and fails to submit, stranding the text in the input box
  // (observed: user follow-ups stuck for hours). A second bare Enter is a
  // no-op when the first worked (input already empty) and submits the
  // stranded text when it didn't.
  await sleep(1200)
  await tmux('send-keys', '-t', paneId, 'Enter')
}

/** A member pane is alive when its foreground process is still the agent
 * (claude/node), not a shell left behind by a failed spawn. */
async function paneAlive(paneId: string): Promise<boolean> {
  try {
    const { stdout } = await execFileP('tmux', [
      'display-message', '-p', '-t', paneId, '#{pane_current_command}',
    ])
    const cmd = stdout.trim()
    return cmd !== '' && !/^(zsh|bash|sh|fish)$/.test(cmd)
  } catch {
    return false // pane gone entirely
  }
}

// ── surface abstraction ──────────────────────────────────────────────

interface IncomingMsg {
  text: string
  createMs: number
  /** member names resolved from native @mentions (topic mode only) */
  mentionMembers: string[]
}

interface RoomIO {
  seed(room: RoomState): Promise<void>
  /** needsUser: the body summons the user — make sure she gets a real mention */
  mirrorMailbox(room: RoomState, ev: MailboxEvent, needsUser: boolean): Promise<void>
  /** the lead's spawn task-sheet for a new member — mirrored so how the
   * lead split the work is visible (and correctable) from Feishu */
  mirrorSpawn(room: RoomState, member: string, prompt: string): Promise<void>
  mirrorSummary(room: RoomState, ev: AssistantTextEvent): Promise<void>
  /** codex's heterogeneous review of the converged result, mirrored through
   * the challenger bot identity (codex 借质询身份发声) */
  mirrorCodexReview(
    room: RoomState,
    verdict: 'PASS' | 'BLOCK' | 'UNKNOWN',
    text: string,
  ): Promise<void>
  /** lead's standby chatter / stage reports — `pingHint` customizes the
   * real-@ wording when needsUser */
  mirrorLeadNote(
    room: RoomState,
    ev: AssistantTextEvent,
    needsUser: boolean,
    pingHint?: string,
  ): Promise<void>
  /** a member's direct answer to the user (they were @-addressed), or the
   * lead proactively calling for her — `ping` sends a real notifying @ */
  mirrorReply(room: RoomState, ev: AssistantTextEvent, ping: boolean): Promise<void>
  /** bridge's own notices (hints, command feedback) */
  notice(room: RoomState, text: string): Promise<void>
  incoming(room: RoomState): Promise<IncomingMsg[]>
}

const PING_THROTTLE_MS = 60_000

// clawx-style seed: first line becomes the topic title in a topic group.
function seedText(room: RoomState, memberNames?: string[], userOpenId?: string): string {
  const created = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16)
  const lines = [
    `🆕 ${room.label}`,
    `🆔 rid: ${room.id}`,
    `🕒 ${created} CST · 来自 终端 (clawx room) · 模板: ${room.template ?? 'design'}`,
    `📁 ${room.cwd}`,
    `💻 围观: tmux attach -t ${room.tmuxSession}`,
  ]
  if (memberNames && memberNames.length > 0) lines.push(`👥 ${memberNames.join(' · ')}`)
  if (!room.topic) lines.push(`📝 议题待描述:直接在本话题里说,队长听懂后自动组队开聊`)
  lines.push(`💬 直接回复=群发 · @某个bot=定向 · esc=打断 · /status · /end`)
  if (userOpenId) lines.push(`<at user_id="${userOpenId}"></at>`)
  return lines.join('\n')
}

// ── topic (multi-bot identities in a topic group) ────────────────────

function topicIO(fleet: LarkFleet): RoomIO {
  const cfg = fleet.cfg
  // ⚠️ open_id is APP-SCOPED for reads: the open_id of bot X as seen by the
  // reader app differs from X's self-view (bot/v3/info). So native mentions
  // are matched primarily by display NAME (stable across apps); the
  // self-view open_id map is kept only as a fallback. For SENDS the server
  // canonicalizes at-tag open_ids across app scopes (scripts/at-render-probe.ts),
  // so any app can mention the user or another bot in a text message.
  const openIdToMember = new Map<string, string>()
  const nameToMember = new Map<string, string>()
  for (const [member, appKey] of Object.entries(cfg.roleMap)) {
    const oid = cfg.botOpenIds?.[appKey]
    if (oid) openIdToMember.set(oid, member)
    const display = cfg.apps[appKey]?.name
    if (display) {
      nameToMember.set(display, member)
      nameToMember.set(display.replace(/^Forge/i, ''), member) // 主案/质询/队长
    }
    nameToMember.set(member, member) // proposer/challenger/team-lead
  }
  const mentionTargets = buildMentionTargets(cfg)
  const uat = userAtTag(cfg)

  function displayOf(member: string): string {
    const key = cfg.roleMap[member] ?? cfg.roleMap[member.replace(/-\d+$/, '')]
    return (key && cfg.apps[key]?.name) || member
  }

  function resolveMentions(mentions: { id: string; name: string }[]): string[] {
    const out: string[] = []
    for (const m of mentions) {
      const byName = nameToMember.get(m.name)
      const member = byName ?? openIdToMember.get(m.id)
      if (member && !out.includes(member)) out.push(member)
    }
    return out
  }

  async function ensureThread(room: RoomState): Promise<string> {
    if (room.threadId) return room.threadId
    if (room.threadRootId) {
      const res = await fleet.reader().api('GET', `/open-apis/im/v1/messages/${room.threadRootId}`)
      const item = (res.data?.items ?? [])[0] as { thread_id?: string } | undefined
      if (item?.thread_id) room.threadId = item.thread_id
    }
    if (!room.threadId) throw new Error('topic thread not established yet')
    return room.threadId
  }

  /** One merged v2 card spoken by `member`'s own bot. The body is split
   * into segments: lines carrying @tokens become div/lark_md (blue mention
   * chips), the rest keeps the full markdown surface. When the user should
   * be flagged but no line mentions her, an @-footer line is appended —
   * 'force' always, 'throttle' at most once per minute. (v2 chips are
   * visual only — by design; she reads every message anyway.) */
  async function sendMemberCard(
    room: RoomState,
    member: string,
    card: { title: string; body: string; subtitle?: string },
    needUser: 'force' | 'throttle' | 'no',
    hint: string,
  ): Promise<void> {
    if (!room.threadRootId) return
    const { segments, mentionedUser } = splitForCard(capBody(card.body), mentionTargets)
    if (!mentionedUser && needUser !== 'no' && uat) {
      const now = Date.now()
      if (needUser === 'force' || !room.lastPingMs || now - room.lastPingMs >= PING_THROTTLE_MS) {
        segments.push({ kind: 'at', text: `${uat} ${hint}` })
        room.lastPingMs = now
      }
    } else if (mentionedUser) {
      room.lastPingMs = Date.now()
    }
    await fleet.appForMember(member).replyCardInThread(
      room.threadRootId,
      buildRichCard({ from: member, title: card.title, subtitle: card.subtitle, segments }),
    )
  }

  /** A REAL notifying @ — a short text from the reader app right after the
   * card. v2 card chips are visual-only, so milestone moments (convergence,
   * the lead calling for her) get their push through this channel. */
  async function pingText(room: RoomState, hint: string, force: boolean): Promise<void> {
    if (!room.threadRootId || !uat) return
    const now = Date.now()
    if (!force && room.lastRealPingMs && now - room.lastRealPingMs < PING_THROTTLE_MS) return
    room.lastRealPingMs = now
    await fleet.reader().replyInThread(room.threadRootId, `${uat} ${hint}`)
  }

  return {
    async seed(room) {
      const lead = fleet.reader()
      // Real bot mentions when open_ids are configured (the server resolves
      // them across app scopes); plain names otherwise.
      const names = Object.entries(cfg.roleMap).map(([member, key]) => {
        const oid = cfg.botOpenIds?.[key]
        const display = cfg.apps[key]?.name ?? member
        return oid ? `<at user_id="${oid}">${display}</at>` : display
      })
      // room.chatId, not cfg.topicChatId — rooms may live in named groups.
      const root = await lead.sendText(room.chatId, seedText(room, names, cfg.userOpenId))
      room.threadRootId = root.messageId
      room.threadId = root.threadId
      await ensureThread(room).catch(() => undefined)
    },
    async mirrorMailbox(room, ev, needsUser) {
      if (!room.threadRootId) return
      if (!ev.body.trim()) return // filter: empty payloads aren't worth mirroring
      // Recipient line first — "@Forge队长" renders as a blue chip.
      await sendMemberCard(
        room,
        ev.from,
        {
          title: deriveCardTitle(ev.summary, ev.body, '消息'),
          body: `@${displayOf(ev.to)}\n${ev.body}`,
          subtitle: `→ 致 ${displayOf(ev.to)}`,
        },
        needsUser ? 'throttle' : 'no',
        '↑ 需要你看一下',
      )
    },
    async mirrorSpawn(room, member, prompt) {
      await sendMemberCard(
        room,
        LEAD_NAME,
        {
          title: `📋 派活 → ${displayOf(member)}`,
          body: prompt,
          subtitle: `→ 致 ${displayOf(member)}`,
        },
        'no',
        '',
      )
    },
    async mirrorSummary(room, ev) {
      const tail = `──\n✓ 已收敛,结论待你验收;可继续 @ 任一 bot 追问,或 /end 收尾`
      await sendMemberCard(
        room,
        ev.from,
        { title: '📋 收敛总结', body: `${ev.text}\n${tail}` },
        'force',
        '↑ 待你验收',
      )
      await pingText(room, '✅ 已收敛,结论见上方卡片,待你验收', true)
    },
    async mirrorCodexReview(room, verdict, text) {
      const head =
        verdict === 'BLOCK'
          ? '🔍 codex 异质审查 · ⚠️ 发现硬伤(打回再议)'
          : verdict === 'PASS'
            ? '🔍 codex 异质审查 · ✓ 通过'
            : '🔍 codex 异质审查'
      // codex can't join the (claude-only) team — it stands in as the 质询 bot.
      await sendMemberCard(room, 'challenger', { title: head, body: text }, 'force', '↑ codex 审查意见')
      await pingText(
        room,
        verdict === 'BLOCK'
          ? '🔍 codex 异质审查发现硬伤,已打回再议,见上方卡片'
          : '🔍 codex 异质审查通过,见上方卡片',
        true,
      )
    },
    async mirrorLeadNote(room, ev, needsUser, pingHint) {
      await sendMemberCard(
        room,
        ev.from,
        { title: deriveCardTitle('', ev.text, '队长'), body: ev.text },
        needsUser ? 'force' : 'no',
        '↑ 队长在等你的输入',
      )
      if (needsUser) await pingText(room, pingHint ?? '🔔 队长在等你的输入,见上方卡片', false)
    },
    async mirrorReply(room, ev, ping) {
      await sendMemberCard(
        room,
        ev.from,
        {
          title: deriveCardTitle('', ev.text, '回复'),
          body: ev.text,
          subtitle: `→ 致 ${cfg.userName ?? '用户'}`,
        },
        'force',
        '↑ 回复了你',
      )
      if (ping) await pingText(room, '🔔 需要你看一下,见上方卡片', false)
    },
    async notice(room, text) {
      if (!room.threadRootId) return
      await fleet.reader().replyInThread(room.threadRootId, atify(text, mentionTargets).out)
    },
    async incoming(room) {
      const threadId = await ensureThread(room).catch(() => null)
      if (!threadId) return []
      const msgs = await fleet.reader().listThreadMessages(threadId)
      const out: IncomingMsg[] = []
      for (const m of msgs) {
        if (m.senderType !== 'user' || m.createMs <= room.larkSinceMs) continue
        // Learn the human's open_id from her first message (used to @ her
        // in future seeds, clawx-style).
        if (!cfg.userOpenId && m.senderId) {
          cfg.userOpenId = m.senderId
          saveUserOpenId(m.senderId)
          log.info('learned user open_id', { openId: m.senderId })
        }
        let mentionMembers = resolveMentions(m.mentions)
        // strip @_user_N placeholders the mention leaves in the text
        let text = m.text.replace(/@_user_\d+\s*/g, '').trim()
        // plain-text fallback: "@Forge主案 …" / "@主案 …" / "@proposer …"
        if (mentionMembers.length === 0) {
          const at = text.match(/^@(\S+)\s+([\s\S]+)$/)
          const member = at?.[1] ? nameToMember.get(at[1]) : undefined
          if (member && at?.[2]) {
            mentionMembers = [member]
            text = at[2].trim()
          }
        }
        // Download any images (reader app has topic read perms), append
        // each as an `@path` token at the END so the agent (claude REPL /
        // codex) reads them — appended last to not disturb the leading
        // "@member" routing parse above.
        let withImages = text
        for (const key of m.imageKeys) {
          const p = await fleet.reader().downloadResource(m.messageId, key, 'image')
          if (p) withImages = `${withImages} @${p}`.trim()
        }
        out.push({ text: withImages, createMs: m.createMs, mentionMembers })
      }
      return out.sort((a, b) => a.createMs - b.createMs)
    },
  }
}

// ── outbound: jsonl → Feishu ─────────────────────────────────────────

/** Resolve team + member jsonl mapping as the team materializes.
 * Re-read the config every tick: members can join (or be respawned)
 * at any time, and the file is tiny. Returns members whose spawn
 * task-sheet hasn't been mirrored yet. */
async function refreshTopology(room: RoomState): Promise<{ name: string; prompt: string }[]> {
  const newSpawns: { name: string; prompt: string }[] = []
  const team = findTeam(room.createdAt, room.teamName)
  if (team) {
    room.teamName = team.name
    room.spawnEchoed ??= {}
    for (const m of team.members) {
      // The lead is the room's own REPL — launcher owns its real tmux pane in
      // room.leadPaneId. Its paneId in the team config is a logical placeholder
      // ("leader"), NOT a tmux pane. So keep the lead OUT of memberPane (else
      // checkDeadPanes probes "leader", finds nothing, and falsely respawns the
      // lead on boot), and only trust a real %-pane to seed leadPaneId.
      if (m.paneId && !m.isLead) room.memberPane[m.name] = m.paneId
      if (m.isLead && room.leadPaneId === undefined && m.paneId?.startsWith('%')) {
        room.leadPaneId = m.paneId
      }
      if (!m.isLead && m.prompt && !room.spawnEchoed[m.name]) {
        room.spawnEchoed[m.name] = true
        newSpawns.push({ name: m.name, prompt: m.prompt })
      }
    }
    const projectDir = projectDirForCwd(room.cwd)
    if (projectDir) {
      const leadJsonl = `${projectDir}/${team.leadSessionId}.jsonl`
      const leadName = team.members.find((m) => m.isLead)?.name ?? 'team-lead'
      room.memberJsonl[leadName] = leadJsonl
    }
  }
  const projectDir = projectDirForCwd(room.cwd)
  if (!projectDir) return newSpawns
  // Standby phase: no team config yet, but the lead session is already
  // chatting with the user. Its first prompt contains the room id (the
  // team name is room-<rid>), which identifies its jsonl.
  if (!room.memberJsonl[LEAD_NAME]) {
    for (const file of listSessionJsonls(projectDir, room.createdAt)) {
      const head = firstUserText(file)
      if (head && head.includes(`room-${room.id}`)) {
        room.memberJsonl[LEAD_NAME] = file
        log.info('lead jsonl mapped (standby)', { file })
        break
      }
    }
  }
  // Member jsonls are matched by each member's own spawn prompt from the
  // team config (it embeds the room id). Multiple rooms can share one cwd —
  // and therefore one projects dir — so name-based heuristics leak sessions
  // across rooms (observed: one jsonl mirrored into two rooms' topics).
  if (!team) return newSpawns
  const mapped = new Set(Object.values(room.memberJsonl))
  const candidates = team.members.filter(
    (m) => !m.isLead && !room.memberJsonl[m.name] && m.promptHead.length >= 20,
  )
  if (candidates.length === 0) return newSpawns
  for (const file of listSessionJsonls(projectDir, room.createdAt)) {
    if (mapped.has(file)) continue
    const head = firstUserText(file)
    if (!head) continue
    let owner = candidates.find((m) => head.includes(m.promptHead))
    if (!owner && head.includes(`room-${room.id}`)) {
      // Prompt drifted from the config copy but the room id pins the file
      // to THIS room — fall back to earliest-name-position among our own
      // unmapped members.
      let bestPos = Number.POSITIVE_INFINITY
      for (const m of candidates) {
        const pos = head.indexOf(m.name)
        if (pos >= 0 && pos < bestPos) {
          owner = m
          bestPos = pos
        }
      }
    }
    if (!owner) continue
    room.memberJsonl[owner.name] = file
    mapped.add(file)
    candidates.splice(candidates.indexOf(owner), 1)
    log.info('member jsonl mapped', { name: owner.name, file })
    if (candidates.length === 0) break
  }
  return newSpawns
}

const LEAD_NAME = 'team-lead'

/** Lead texts that read like a delivery/completion milestone — they get a
 * real notifying @ even when the lead forgot to write one (instruction
 * drift in long sessions is the norm, observed on a 1287-char 最终交付
 * declaration that carried no @ at all). */
const MILESTONE_RE = /最终交付|交付确认|全部就绪|全部完成|任务完成|收尾完成|可交付|待你验收|可合入/

async function tickOutbound(room: RoomState, io: RoomIO, userName: string): Promise<void> {
  let sawTeamLeadMsg = false
  for (const [name, file] of Object.entries(room.memberJsonl)) {
    const offset = room.jsonlOffsets[file] ?? 0
    const { events, lineCount } = readNewEvents(file, offset, name)
    room.jsonlOffsets[file] = lineCount
    for (const ev of events) {
      if (ev.kind === 'mailbox') {
        // When the body summons the user, the mirror itself carries the
        // real mention — no separate ping message.
        await io.mirrorMailbox(room, ev, wantsUser(ev.body, userName))
        if (ev.to === LEAD_NAME) sawTeamLeadMsg = true
      } else if (ev.kind === 'assistant' && name === LEAD_NAME) {
        const needsUser = wantsUser(ev.text, userName)
        if (room.status === 'converged' && !room.summaryMirrored && ev.text.length > 120) {
          // Summary card + a real notifying @ (mirrorSummary pings itself).
          await io.mirrorSummary(room, ev)
          room.summaryMirrored = true
          // A1: heterogeneous codex gate. With codexReview on, hand the
          // converged conclusion to codex (a non-claude model) to catch what
          // the all-claude team blind-spotted. BLOCK → bounce back to the
          // lead for one more round, capped at CODEX_MAX_ROUNDS.
          if (room.codexReview && (room.codexRound ?? 0) < CODEX_MAX_ROUNDS) {
            await io.notice(room, '🔍 codex 异质审查中(把收敛结论交给异质模型把关,稍候)…')
            const r = await runCodexReview(room.cwd, ev.text)
            if (!r.ok) {
              await io.notice(room, `🔍 codex 审查没跑成(${r.error ?? '未知'}),按已收敛处理`)
            } else {
              await io.mirrorCodexReview(room, r.verdict, clip(r.text))
              if (r.verdict === 'BLOCK' && room.leadPaneId) {
                room.codexRound = (room.codexRound ?? 0) + 1
                room.status = 'running'
                room.summaryMirrored = false
                await sendKeysTo(
                  room.leadPaneId,
                  `[codex 异质审查·第 ${room.codexRound}/${CODEX_MAX_ROUNDS} 轮:BLOCK] 收敛结论被异质模型判定有硬伤。请认真评估下面的意见——该修的修、确实站得住的就有理有据地反驳,然后重新走一遍收敛:\n${r.text}`,
                )
              }
            }
          }
        } else if (room.status === 'starting' && ev.text.length > 10) {
          // Standby: the lead is clarifying the topic with the user —
          // mirror so the whole exchange works from Feishu alone.
          await io.mirrorLeadNote(room, ev, needsUser)
        } else if (room.awaitReply?.[name] && ev.text.length > 80) {
          await io.mirrorReply(room, ev, true)
          delete room.awaitReply[name]
        } else if (needsUser && ev.text.length > 80) {
          // The lead proactively calls for her (completion report, a
          // decision to make) outside any other path. Without this branch
          // such texts were silently dropped once summaryMirrored burned —
          // the "task finished but nobody told me" hole.
          await io.mirrorReply(room, ev, true)
        } else if (ev.text.length > 120) {
          // Stage report without any @ (the lead drifts off rule 11 in
          // long sessions): mirror for visibility; real-ping only when it
          // reads like a delivery milestone.
          await io.mirrorLeadNote(room, ev, MILESTONE_RE.test(ev.text), '✅ 任务到达节点,见上方卡片')
        }
      } else if (
        ev.kind === 'assistant' &&
        room.awaitReply?.[name] &&
        ev.text.length > 80
      ) {
        // The user @-addressed this member; its substantive reply must
        // reach Feishu (plain assistant text is otherwise terminal-only).
        await io.mirrorReply(room, ev, true)
        delete room.awaitReply[name]
      }
    }
  }
  if (sawTeamLeadMsg && room.status === 'running') room.status = 'converged'
  if (room.status === 'starting' && Object.keys(room.memberJsonl).length > 1) room.status = 'running'
}

// ── inbound: Feishu → tmux panes ─────────────────────────────────────

function allPanes(room: RoomState): { name: string; pane: string }[] {
  const out: { name: string; pane: string }[] = []
  if (room.leadPaneId) out.push({ name: LEAD_NAME, pane: room.leadPaneId })
  for (const [name, pane] of Object.entries(room.memberPane)) {
    if (pane && !out.some((p) => p.pane === pane)) out.push({ name, pane })
  }
  return out
}

/** Resolve the deliverable pane for a member: exact name if alive, else
 * an alive respawned sibling (proposer → proposer-2). */
async function resolveMemberPane(
  room: RoomState,
  name: string,
): Promise<{ name: string; pane: string } | null> {
  if (name === LEAD_NAME) {
    return room.leadPaneId ? { name, pane: room.leadPaneId } : null
  }
  const exact = room.memberPane[name]
  if (exact && (await paneAlive(exact))) return { name, pane: exact }
  const base = name.replace(/-\d+$/, '')
  for (const [candidate, pane] of Object.entries(room.memberPane)) {
    if (candidate === name || !pane) continue
    if (candidate.replace(/-\d+$/, '') !== base) continue
    if (await paneAlive(pane)) return { name: candidate, pane }
  }
  return null
}

async function routeIncoming(room: RoomState, io: RoomIO, msg: IncomingMsg, userName: string): Promise<'continue' | 'end'> {
  const t = msg.text.trim()
  if (t === 'esc') {
    if (room.leadPaneId) await tmux('send-keys', '-t', room.leadPaneId, 'Escape')
    await io.notice(room, '⎋ 已发送 Esc(打断 lead 当前生成)')
    return 'continue'
  }
  if (t === '/status') {
    const members = Object.keys(room.memberPane).join(' / ') || '(组建中)'
    await io.notice(room, `房间 ${room.id} · ${room.status}\n成员: ${members}\n围观: tmux attach -t ${room.tmuxSession}`)
    return 'continue'
  }
  if (t === '/end') {
    if (room.leadPaneId) {
      await sendKeysTo(room.leadPaneId, '请让所有 teammate shutdown,然后清理团队(clean up the team)。')
    }
    await io.notice(room, `✓ 已通知 lead 收尾。tmux 会话稍后可用 tmux kill-session -t ${room.tmuxSession} 清掉。`)
    return 'end'
  }

  room.awaitReply ??= {}

  // 1. native @mentions (topic mode)
  if (msg.mentionMembers.length > 0) {
    const delivered: string[] = []
    const fallback: string[] = []
    for (const name of msg.mentionMembers) {
      const target = await resolveMemberPane(room, name)
      if (target) {
        await sendKeysTo(target.pane, `[来自 ${userName}] ${t}`)
        delivered.push(target.name)
        room.awaitReply[target.name] = true
      } else if (room.leadPaneId) {
        // Not born yet or process dead — hand to the lead instead of dropping.
        await sendKeysTo(room.leadPaneId, `[来自 ${userName},@${name} 但其不在线——请你先接住:转达或代答] ${t}`)
        fallback.push(name)
        room.awaitReply[LEAD_NAME] = true
      }
    }
    const parts: string[] = []
    if (delivered.length) parts.push(`✓ 已转给 ${delivered.join(' / ')}`)
    if (fallback.length) parts.push(`⚠️ @${fallback.join('/')} 不在线,已交队长接住`)
    await io.notice(room, parts.join(' · ') || '✗ 无可达成员')
    return 'continue'
  }

  // 2. text-prefix fallback: "@name 内容"
  const at = t.match(/^@(\S+)\s+([\s\S]+)$/)
  if (at && at[1] && at[2]) {
    const name = at[1]
    const target = await resolveMemberPane(room, name)
    if (target) {
      await sendKeysTo(target.pane, `[来自 ${userName}] ${at[2]}`)
      room.awaitReply[target.name] = true
      await io.notice(room, `✓ 已转给 ${target.name}`)
      return 'continue'
    }
    await io.notice(room, `✗ 成员「${name}」不在线。可用: ${Object.keys(room.memberPane).join(' / ')}`)
    return 'continue'
  }

  // 3. no mention → broadcast to everyone alive (group-chat semantics)
  const delivered: string[] = []
  for (const { name, pane } of allPanes(room)) {
    if (!(await paneAlive(pane))) continue
    await sendKeysTo(pane, `[来自 ${userName}·群发] ${t}`)
    delivered.push(name)
    room.awaitReply[name] = true
  }
  await io.notice(room, `✓ 已群发给 ${delivered.join(' / ') || '(无人在线)'}`)
  return 'continue'
}

/** Detect member processes that died (failed spawn leaves a bare shell in
 * the pane) — notify once and ask the lead to respawn. */
async function checkDeadPanes(room: RoomState, io: RoomIO): Promise<void> {
  room.deadNotified ??= {}
  for (const [name, pane] of Object.entries(room.memberPane)) {
    if (!pane) continue
    // The lead is launcher-owned (room.leadPaneId), never a respawnable
    // teammate — skip it so a placeholder pane can't trigger a bogus respawn.
    if (name === LEAD_NAME) continue
    if (await paneAlive(pane)) {
      delete room.deadNotified[name]
      continue
    }
    if (room.deadNotified[name]) continue
    room.deadNotified[name] = true
    log.warn('member pane dead', { name, pane })
    await io.notice(room, `⚠️ ${name} 的进程已死(spawn 失败或崩溃),已请队长重新 spawn`)
    if (room.leadPaneId && (await paneAlive(room.leadPaneId))) {
      await sendKeysTo(
        room.leadPaneId,
        `[系统] 检测到 ${name} 的进程已死(它的 pane 只剩一个空 shell)。请重新 spawn 同名同角色同模型的 ${name},并把任务上下文重新交给它。`,
      )
    }
  }
}

async function tickInbound(room: RoomState, io: RoomIO, userName: string): Promise<'continue' | 'end'> {
  const msgs = await io.incoming(room)
  for (const m of msgs) {
    room.larkSinceMs = Math.max(room.larkSinceMs, m.createMs)
    const verdict = await routeIncoming(room, io, m, userName)
    if (verdict === 'end') return 'end'
  }
  return 'continue'
}

// ── main loop ────────────────────────────────────────────────────────

/** Take the per-room single-instance lock. Refuses when another live
 * bridge holds it; silently takes over a stale (dead-pid) lock. */
function acquireBridgeLock(roomId: string): boolean {
  const p = bridgeLockPath(roomId)
  try {
    fs.writeFileSync(p, String(process.pid), { flag: 'wx' })
    return true
  } catch {
    const old = readBridgeLockPid(roomId)
    if (old && old !== process.pid) {
      try {
        process.kill(old, 0)
        return false // alive — refuse to double-run
      } catch {
        /* stale */
      }
    }
    fs.writeFileSync(p, String(process.pid))
    return true
  }
}

export function releaseBridgeLock(roomId: string): void {
  try {
    fs.rmSync(bridgeLockPath(roomId), { force: true })
  } catch {
    /* best-effort */
  }
}

export async function runBridge(room: RoomState): Promise<void> {
  if (!acquireBridgeLock(room.id)) {
    log.warn('another bridge already runs this room — exiting', { id: room.id })
    return
  }
  // Record our own pid: authoritative, survives whoever spawned us.
  room.bridgePid = process.pid
  const fleetCfg = loadLarkApps()
  if (!fleetCfg) {
    log.warn('room needs the multi-bot fleet config (lark-apps.json) — exiting', { id: room.id })
    releaseBridgeLock(room.id)
    return
  }
  const io: RoomIO = topicIO(new LarkFleet(fleetCfg))
  const userName = fleetCfg.userName ?? '用户'

  // Seed only once (bridge restarts must not re-seed).
  if (!room.threadRootId) {
    await io.seed(room)
    saveRoom(room)
  }
  log.info('bridge running', { id: room.id, mode: 'topic', chatId: room.chatId })

  for (;;) {
    try {
      const newSpawns = await refreshTopology(room)
      for (const s of newSpawns) {
        // Show how the lead split the work the moment a teammate is born —
        // a misread task-sheet is correctable here, not after the wrong
        // deliverable lands.
        await io.mirrorSpawn(room, s.name, s.prompt)
      }
      await checkDeadPanes(room, io)
      await tickOutbound(room, io, userName)
      const verdict = await tickInbound(room, io, userName)
      saveRoom(room)
      if (verdict === 'end') {
        room.status = 'ended'
        saveRoom(room)
        releaseBridgeLock(room.id)
        log.info('bridge ended by /end', { id: room.id })
        return
      }
    } catch (e) {
      log.warn('bridge tick error (continuing)', { err: (e as Error).message })
    }
    await sleep(TICK_MS)
  }
}
