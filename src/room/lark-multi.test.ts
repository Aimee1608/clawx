import { describe, expect, it } from 'vitest'

import { isTopicChat, parseMessage, resolveGroupChat, type LarkAppsConfig } from './lark-multi.js'

const cfg: LarkAppsConfig = {
  topicChatId: 'oc_main',
  groups: { dev: 'oc_dev', review: 'oc_review' },
  reader: 'lead',
  roleMap: {},
  apps: {},
}

describe('resolveGroupChat', () => {
  it('returns the default topic chat when no group is named', () => {
    expect(resolveGroupChat(cfg, undefined)).toBe('oc_main')
  })

  it('resolves a registered named group', () => {
    expect(resolveGroupChat(cfg, 'dev')).toBe('oc_dev')
  })

  it('returns null for an unknown group name', () => {
    expect(resolveGroupChat(cfg, 'nope')).toBeNull()
  })
})

describe('isTopicChat', () => {
  it('matches the default topic chat', () => {
    expect(isTopicChat(cfg, 'oc_main')).toBe(true)
  })

  it('matches a named group chat', () => {
    expect(isTopicChat(cfg, 'oc_review')).toBe(true)
  })

  it('rejects an unrelated chat id', () => {
    expect(isTopicChat(cfg, 'oc_other')).toBe(false)
  })
})

describe('parseMessage', () => {
  it('parses a plain text message from a user', () => {
    const m = parseMessage({
      message_id: 'm1',
      create_time: '1700000000000',
      msg_type: 'text',
      sender: { sender_type: 'user', id: 'u1' },
      body: { content: JSON.stringify({ text: '你好' }) },
    })
    expect(m).toMatchObject({ messageId: 'm1', text: '你好', senderType: 'user', senderId: 'u1', imageKeys: [] })
    expect(m?.createMs).toBe(1700000000000)
  })

  it('extracts image_key from an image message', () => {
    const m = parseMessage({
      message_id: 'm2',
      msg_type: 'image',
      sender: { sender_type: 'user' },
      body: { content: JSON.stringify({ image_key: 'img_abc' }) },
    })
    expect(m?.imageKeys).toEqual(['img_abc'])
  })

  it('extracts embedded <img> + text from a rich-text post', () => {
    const content = JSON.stringify({
      title: '',
      content: [[{ tag: 'text', text: '看这张' }, { tag: 'img', image_key: 'img_post' }]],
    })
    const m = parseMessage({ message_id: 'm3', msg_type: 'post', body: { content } })
    expect(m?.imageKeys).toEqual(['img_post'])
    expect(m?.text).toBe('看这张')
  })

  it('collects multiple images across post lines', () => {
    const content = JSON.stringify({
      content: [
        [{ tag: 'img', image_key: 'a' }],
        [{ tag: 'text', text: 'mid' }, { tag: 'img', image_key: 'b' }],
      ],
    })
    const m = parseMessage({ message_id: 'm3b', msg_type: 'post', body: { content } })
    expect(m?.imageKeys).toEqual(['a', 'b'])
  })

  it('maps mentions', () => {
    const m = parseMessage({
      message_id: 'm4',
      msg_type: 'text',
      body: { content: '{}' },
      mentions: [{ id: 'ou_x', name: 'X' }],
    })
    expect(m?.mentions).toEqual([{ id: 'ou_x', name: 'X' }])
  })

  it('treats a non-user sender as app', () => {
    const m = parseMessage({
      message_id: 'm5',
      msg_type: 'text',
      sender: { sender_type: 'app', id: 'cli_bot' },
      body: { content: '{}' },
    })
    expect(m?.senderType).toBe('app')
  })

  it('returns null without a message_id', () => {
    expect(parseMessage({ msg_type: 'text', body: { content: '{}' } })).toBeNull()
  })

  it('returns null on malformed content json', () => {
    expect(parseMessage({ message_id: 'm6', body: { content: '{not json' } })).toBeNull()
  })
})
