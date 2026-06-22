// Multi-app Lark client for the room bridge: each agent speaks through its
// own Feishu app (distinct bot identity in the topic group). Plain fetch,
// direct to open.feishu.cn — Node's fetch ignores proxy env vars, which is
// exactly what we want (Feishu must NOT go through mihomo).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { configDir } from '../config.js'

const BASE = 'https://open.feishu.cn'

export interface AppCred {
  name: string
  appId: string
  appSecret: string
}

export interface LarkAppsConfig {
  /** default topic group */
  topicChatId: string
  /** named topic-group registry (clawx --group style): name -> chat_id */
  groups?: Record<string, string>
  reader: string // app key used for polling reads
  roleMap: Record<string, string> // member name -> app key
  apps: Record<string, AppCred>
  botOpenIds?: Record<string, string> // app key -> bot open_id (mention routing)
  /** the user's open_id (learned from their first message; used to @ them in seeds) */
  userOpenId?: string
  /** the user's Feishu display name — used in agent-facing prefixes and
   * the "@<name>" attention convention */
  userName?: string
  /** extra names agents may call the user by (e.g. a real display name) —
   * all become mention aliases alongside userName */
  userAliases?: string[]
}

/** Resolve a named group to its chat_id (undefined name → default group). */
export function resolveGroupChat(cfg: LarkAppsConfig, group?: string): string | null {
  if (!group) return cfg.topicChatId
  return cfg.groups?.[group] ?? null
}

/** Is this chat one of our topic groups (default or named)? */
export function isTopicChat(cfg: LarkAppsConfig, chatId: string): boolean {
  if (chatId === cfg.topicChatId) return true
  return Object.values(cfg.groups ?? {}).includes(chatId)
}

/** Persist the learned user open_id back into the config file. */
export function saveUserOpenId(openId: string): void {
  const file = path.join(configDir(), 'lark-apps.json')
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as LarkAppsConfig
    if (cfg.userOpenId === openId) return
    cfg.userOpenId = openId
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  } catch {
    /* best-effort */
  }
}

export function loadLarkApps(): LarkAppsConfig | null {
  const file = path.join(configDir(), 'lark-apps.json')
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as LarkAppsConfig
    if (!cfg.topicChatId || !cfg.apps || !cfg.roleMap) return null
    return cfg
  } catch {
    return null
  }
}

interface LarkResp {
  code: number
  msg: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any
  tenant_access_token?: string
  expire?: number
}

export class LarkApp {
  private token = ''
  private tokenExpiresAt = 0

  constructor(readonly key: string, readonly cred: AppCred) {}

  private async ensureToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - 300_000) return this.token
    const res = await fetch(`${BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.cred.appId, app_secret: this.cred.appSecret }),
    })
    const body = (await res.json()) as LarkResp
    if (body.code !== 0 || !body.tenant_access_token) {
      throw new Error(`tenant_access_token failed for ${this.cred.name}: ${body.code} ${body.msg}`)
    }
    this.token = body.tenant_access_token
    this.tokenExpiresAt = Date.now() + (body.expire ?? 3600) * 1000
    return this.token
  }

  async api(method: 'GET' | 'POST', apiPath: string, params?: object, data?: object): Promise<LarkResp> {
    const token = await this.ensureToken()
    let url = `${BASE}${apiPath}`
    if (params) {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(params as Record<string, unknown>)) qs.set(k, String(v))
      url += `?${qs.toString()}`
    }
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: data ? JSON.stringify(data) : undefined,
    })
    return (await res.json()) as LarkResp
  }

  async botInfo(): Promise<{ openId: string; name: string }> {
    const res = await this.api('GET', '/open-apis/bot/v3/info')
    if (res.code !== 0) throw new Error(`bot info failed for ${this.cred.name}: ${res.code} ${res.msg}`)
    const bot = res.data?.bot ?? (res as { bot?: { open_id?: string; app_name?: string } }).bot
    return { openId: bot?.open_id ?? '', name: bot?.app_name ?? this.cred.name }
  }

  /** Send a text message to a chat. In a topic group this starts a new topic.
   * Returns message_id and thread_id (when present). */
  async sendText(chatId: string, text: string): Promise<{ messageId: string; threadId?: string }> {
    const res = await this.api(
      'POST',
      '/open-apis/im/v1/messages',
      { receive_id_type: 'chat_id' },
      { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
    )
    if (res.code !== 0) throw new Error(`send failed (${this.cred.name}): ${res.code} ${res.msg}`)
    return { messageId: res.data?.message_id ?? '', threadId: res.data?.thread_id || undefined }
  }

  /** Reply under a topic (thread) rooted at `rootMessageId`. */
  async replyInThread(rootMessageId: string, text: string): Promise<void> {
    const res = await this.api(
      'POST',
      `/open-apis/im/v1/messages/${rootMessageId}/reply`,
      undefined,
      { msg_type: 'text', content: JSON.stringify({ text }), reply_in_thread: true },
    )
    if (res.code !== 0) throw new Error(`reply failed (${this.cred.name}): ${res.code} ${res.msg}`)
  }

  /** Reply an interactive card under a topic. */
  async replyCardInThread(rootMessageId: string, card: Record<string, unknown>): Promise<void> {
    const res = await this.api(
      'POST',
      `/open-apis/im/v1/messages/${rootMessageId}/reply`,
      undefined,
      { msg_type: 'interactive', content: JSON.stringify(card), reply_in_thread: true },
    )
    if (res.code !== 0) throw new Error(`reply card failed (${this.cred.name}): ${res.code} ${res.msg}`)
  }

  /** List messages in a thread (topic). */
  async listThreadMessages(threadId: string, pageSize = 20): Promise<ThreadMessage[]> {
    const res = await this.api('GET', '/open-apis/im/v1/messages', {
      container_id_type: 'thread',
      container_id: threadId,
      sort_type: 'ByCreateTimeDesc',
      page_size: pageSize,
    })
    if (res.code !== 0) return []
    const items: unknown[] = res.data?.items ?? []
    return items.map(parseMessage).filter((m): m is ThreadMessage => m !== null)
  }

  /** Download a message's image/file resource to a local temp file, return
   * its path (or null on failure). Plain fetch of the binary — room's lark
   * layer is fetch-direct (no lark SDK). The agent reads it via `@path`. */
  async downloadResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file' = 'image',
  ): Promise<string | null> {
    try {
      const token = await this.ensureToken()
      const url = `${BASE}/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=${type}`
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) return null
      const ext = type === 'image' ? '.jpg' : '.bin'
      const dest = path.join(os.tmpdir(), `clawx-room-${messageId.slice(-12)}-${fileKey.slice(-8)}${ext}`)
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
      return dest
    } catch {
      return null
    }
  }
}

export interface ThreadMessage {
  messageId: string
  createMs: number
  senderType: 'user' | 'app'
  senderId: string
  text: string
  /** open_ids of mentioned users/bots */
  mentions: { id: string; name: string }[]
  /** image_keys from an image message or a post's embedded <img> segments */
  imageKeys: string[]
}

export function parseMessage(raw: unknown): ThreadMessage | null {
  const it = raw as {
    message_id?: string
    create_time?: string
    msg_type?: string
    sender?: { sender_type?: string; id?: string }
    body?: { content?: string }
    mentions?: { id?: string; name?: string; key?: string }[]
  }
  if (!it.message_id) return null
  let text = ''
  const imageKeys: string[] = []
  try {
    const parsed = JSON.parse(it.body?.content ?? '{}') as Record<string, unknown>
    if (typeof parsed.text === 'string') text = parsed.text
    // image message: { image_key }; post (rich text): 2D segment array
    // with embedded text + <img> segments.
    if (it.msg_type === 'image' && typeof parsed.image_key === 'string') {
      imageKeys.push(parsed.image_key)
    } else if (it.msg_type === 'post' && Array.isArray(parsed.content)) {
      const texts: string[] = []
      for (const line of parsed.content as unknown[]) {
        if (!Array.isArray(line)) continue
        for (const seg of line as Array<Record<string, unknown>>) {
          if (seg?.tag === 'text' && typeof seg.text === 'string') texts.push(seg.text)
          else if (seg?.tag === 'img' && typeof seg.image_key === 'string') imageKeys.push(seg.image_key)
        }
      }
      if (!text && texts.length) text = texts.join(' ')
    }
  } catch {
    return null
  }
  return {
    messageId: it.message_id,
    createMs: Number(it.create_time ?? 0),
    senderType: it.sender?.sender_type === 'user' ? 'user' : 'app',
    senderId: it.sender?.id ?? '',
    text,
    mentions: (it.mentions ?? []).map((m) => ({ id: m.id ?? '', name: m.name ?? '' })),
    imageKeys,
  }
}

/** Bundle of all configured apps, keyed by app key. */
export class LarkFleet {
  readonly apps = new Map<string, LarkApp>()
  constructor(readonly cfg: LarkAppsConfig) {
    for (const [key, cred] of Object.entries(cfg.apps)) this.apps.set(key, new LarkApp(key, cred))
  }
  appForMember(memberName: string): LarkApp {
    // Respawned members get suffixed names (proposer-2) — resolve the
    // identity via the base name so they keep speaking as the same bot.
    const base = memberName.replace(/-\d+$/, '')
    const key = this.cfg.roleMap[memberName] ?? this.cfg.roleMap[base]
    const app = (key && this.apps.get(key)) || this.apps.get(this.cfg.reader)
    if (!app) throw new Error('no reader app configured')
    return app
  }
  reader(): LarkApp {
    const app = this.apps.get(this.cfg.reader)
    if (!app) throw new Error('no reader app configured')
    return app
  }
}
