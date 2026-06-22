import * as lark from '@larksuiteoapi/node-sdk'

import { log } from './logger.js'

/**
 * Thin wrapper over the `@larksuiteoapi/node-sdk` Lark Client for the
 * narrow "Feishu thread per clawx tmux session" use case.
 *
 * Lark has no dedicated "create thread" endpoint: you post a regular
 * message into the chat (which then serves as the thread root), and
 * reply to it with `reply_in_thread: true`. The reply response carries
 * the assigned `thread_id` (format `omt_...`). Subsequent messages can
 * include `thread_id` (or the same `reply_in_thread: true` semantics
 * via the reply API) to land in the same thread.
 */

export interface CreateThreadResult {
  /** Lark message id of the seed (thread root). */
  rootMessageId: string
  /** Lark thread id (omt_*). Used to route inbound messages and to
   * post turn-done replies into this thread. */
  threadId: string
}

export interface LarkThreadService {
  /**
   * Create a new thread in the configured group. Posts the seed
   * message, then sends a "📌 ready" reply with `reply_in_thread: true`
   * so we capture the assigned thread_id. Returns both ids.
   */
  createThread(opts: { chatId: string; seedText: string }): Promise<CreateThreadResult>

  /**
   * Post a text message into an existing thread by replying to the
   * root message with `reply_in_thread: true`.
   */
  postInThread(opts: {
    rootMessageId: string
    text: string
  }): Promise<{ messageId: string }>

  /**
   * Post a Lark interactive card into an existing thread. `card` is
   * the raw Lark card JSON (the SDK stringifies it for us). Used by
   * the user-echo path so forwarded inputs render as a titled card
   * instead of plain `[🖥 web] > ...` text that's easy to skim past.
   *
   * Returns the message_id so callers can later attach reactions
   * (e.g. the ⏳ "in progress" indicator).
   */
  postCardInThread(opts: {
    rootMessageId: string
    card: Record<string, unknown>
  }): Promise<{ messageId: string }>

  /**
   * Add a reaction (emoji) to a Lark message. Used by the
   * PreToolUse-driven "turn-in-progress" indicator: when claude
   * starts using tools in response to a user input, we ⏳ that user's
   * message; once the turn ends we remove the reaction and post the
   * final reply text.
   *
   * `emojiType` is a Lark-defined string constant (e.g. "HOURGLASS",
   * "OK", "DONE"). Operator-tunable via UserConfig.tmuxProgressEmoji
   * because Lark's accepted set changes occasionally.
   */
  addReaction(opts: {
    messageId: string
    emojiType: string
  }): Promise<{ reactionId: string }>

  /** Remove a previously-added reaction by its returned id. Idempotent
   * on a 404 (the reaction may have been pruned by the user or by an
   * earlier retry). */
  removeReaction(opts: { messageId: string; reactionId: string }): Promise<void>
}

export function createLarkThreadService(client: lark.Client): LarkThreadService {
  return {
    async createThread({ chatId, seedText }) {
      // Step 1: post the seed into the chat. This becomes the thread
      // root for reply_in_thread semantics. The seed is *visible* in
      // the chat; we keep it short and informative.
      const seedRes = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: seedText }),
        },
      })
      const rootMessageId = seedRes.data?.message_id
      if (!rootMessageId) {
        throw new Error('lark im.message.create returned no message_id for seed')
      }

      // Step 2: reply to the seed with reply_in_thread=true. Lark
      // creates a fresh thread anchored to the seed and includes the
      // thread_id in the response.
      const replyRes = await client.im.message.reply({
        path: { message_id: rootMessageId },
        data: {
          content: JSON.stringify({ text: '📌 session 已就绪，开始对话…' }),
          msg_type: 'text',
          reply_in_thread: true,
        },
      })
      const threadId = (replyRes.data as { thread_id?: string } | undefined)?.thread_id
      if (!threadId) {
        // The reply landed in the chat but Lark didn't return a
        // thread_id — likely an SDK shape mismatch. Surface enough for
        // the operator to debug.
        log.warn('lark reply did not include thread_id', {
          rootMessageId,
          replyMsgId: replyRes.data?.message_id ?? null,
        })
        throw new Error('lark reply did not include thread_id (Lark API change?)')
      }
      return { rootMessageId, threadId }
    },

    async postInThread({ rootMessageId, text }) {
      const res = await client.im.message.reply({
        path: { message_id: rootMessageId },
        data: {
          content: JSON.stringify({ text }),
          msg_type: 'text',
          reply_in_thread: true,
        },
      })
      const messageId = res.data?.message_id
      if (!messageId) {
        throw new Error('lark im.message.reply returned no message_id')
      }
      return { messageId }
    },

    async postCardInThread({ rootMessageId, card }) {
      const res = await client.im.message.reply({
        path: { message_id: rootMessageId },
        data: {
          content: JSON.stringify(card),
          msg_type: 'interactive',
          reply_in_thread: true,
        },
      })
      const messageId = res.data?.message_id
      if (!messageId) {
        throw new Error('lark im.message.reply (card) returned no message_id')
      }
      return { messageId }
    },

    async addReaction({ messageId, emojiType }) {
      const res = await client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      })
      const reactionId = res.data?.reaction_id
      if (!reactionId) {
        throw new Error('lark messageReaction.create returned no reaction_id')
      }
      return { reactionId }
    },

    async removeReaction({ messageId, reactionId }) {
      try {
        await client.im.messageReaction.delete({
          path: { message_id: messageId, reaction_id: reactionId },
        })
      } catch (err: any) {
        // 404 = reaction already gone (user unreacted manually or a
        // previous removeReaction succeeded but the response was lost).
        // Anything else is worth logging but we don't want a fanout
        // path to fail just because we couldn't clear an emoji.
        const code = err?.response?.data?.code
        if (code === 230002 /* lark "not found" */) return
        log.warn('lark removeReaction failed', {
          messageId,
          reactionId,
          err: err?.message ?? String(err),
        })
      }
    },
  }
}
