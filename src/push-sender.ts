import * as lark from '@larksuiteoapi/node-sdk'

import { log } from './logger.js'

/**
 * Pluggable push channel for unsolicited bot messages.
 * Implementations:
 *   - WsPushSender: uses the bot's own lark Client directly (WS mode
 *     has credentials in-process).
 *   - NullPushSender: logs only, used when no upstream is configured.
 */
export interface PushSender {
  send(text: string): Promise<void>
  /** Human-readable name shown in startup logs. */
  readonly description: string
}

export class NullPushSender implements PushSender {
  description = 'null (logs only)'
  async send(text: string): Promise<void> {
    log.warn('push (drop)', { text: text.slice(0, 200) })
  }
}

/**
 * WS-mode push: clawbot-hub holds the bot's lark Client and the user's
 * openId (resolved on first inbound message). `userOpenId` must be set
 * before calling send(); the scheduler will skip pushes until it is.
 */
export class WsPushSender implements PushSender {
  description = 'ws-direct-lark'
  private userOpenId: string | null = null

  constructor(private readonly client: lark.Client) {}

  setUserOpenId(openId: string): void {
    if (!this.userOpenId) {
      log.info('push (ws) bound to user', { openId })
    }
    this.userOpenId = openId
  }

  async send(text: string): Promise<void> {
    if (!this.userOpenId) {
      log.warn('push (ws skipped, no user openId yet)', { text: text.slice(0, 100) })
      return
    }
    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: this.userOpenId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      })
    } catch (err: any) {
      log.error('push (ws lark)', { err: err?.message ?? String(err) })
    }
  }
}
