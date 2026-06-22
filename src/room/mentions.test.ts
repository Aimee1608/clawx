import { describe, expect, it } from 'vitest'

import type { LarkAppsConfig } from './lark-multi.js'
import { atify, buildMentionTargets, splitForCard, userAtTag, wantsUser } from './mentions.js'

const cfg: LarkAppsConfig = {
  topicChatId: 'oc_test',
  reader: 'lead',
  roleMap: { 'team-lead': 'lead', proposer: 'proposer', challenger: 'challenger' },
  apps: {
    lead: { name: 'Forge队长', appId: 'a', appSecret: 's' },
    proposer: { name: 'Forge主案', appId: 'a', appSecret: 's' },
    challenger: { name: 'Forge质询', appId: 'a', appSecret: 's' },
  },
  botOpenIds: { lead: 'ou_lead', proposer: 'ou_prop', challenger: 'ou_chal' },
  userOpenId: 'ou_user',
  userName: 'operator',
  userAliases: ['小郑'],
}

describe('userAtTag', () => {
  it('builds an <at> tag from userOpenId + userName', () => {
    expect(userAtTag(cfg)).toBe('<at user_id="ou_user">operator</at>')
  })

  it('returns null when userOpenId is unknown', () => {
    expect(userAtTag({ ...cfg, userOpenId: undefined })).toBeNull()
  })
})

describe('buildMentionTargets', () => {
  const targets = buildMentionTargets(cfg)

  it('includes user aliases and the configured display name', () => {
    const userTokens = targets.filter((t) => t.isUser).map((t) => t.token)
    expect(userTokens).toEqual(expect.arrayContaining(['operator', '小郑', '用户']))
  })

  it('includes each bot by display / short / role name', () => {
    const botTokens = targets.filter((t) => !t.isUser).map((t) => t.token)
    expect(botTokens).toEqual(expect.arrayContaining(['Forge主案', '主案', 'proposer']))
  })

  it('sorts longest token first so @Forge主案 wins over @主案', () => {
    const idxLong = targets.findIndex((t) => t.token === 'Forge主案')
    const idxShort = targets.findIndex((t) => t.token === '主案')
    expect(idxLong).toBeLessThan(idxShort)
  })

  it('skips bots without a known open_id', () => {
    const noIds = buildMentionTargets({ ...cfg, botOpenIds: {} })
    expect(noIds.every((t) => t.isUser)).toBe(true)
  })
})

describe('atify', () => {
  const targets = buildMentionTargets(cfg)

  it('replaces a bot token with a real <at> tag, no user ping', () => {
    const r = atify('@Forge主案 麻烦看下', targets)
    expect(r.out).toBe('<at user_id="ou_prop">Forge主案</at> 麻烦看下')
    expect(r.mentionedUser).toBe(false)
  })

  it('flags mentionedUser when an alias is hit', () => {
    const r = atify('@小郑 来拍板', targets)
    expect(r.out).toBe('<at user_id="ou_user">operator</at> 来拍板')
    expect(r.mentionedUser).toBe(true)
  })

  it('prefers the longest token (@Forge主案 not split into @主案)', () => {
    const r = atify('@Forge主案', targets)
    expect(r.out).toBe('<at user_id="ou_prop">Forge主案</at>')
  })

  it('leaves text without @tokens untouched', () => {
    const r = atify('普通一句话,没有提及', targets)
    expect(r.out).toBe('普通一句话,没有提及')
    expect(r.mentionedUser).toBe(false)
  })
})

describe('splitForCard', () => {
  const targets = buildMentionTargets(cfg)

  it('puts @lines into at-segments and plain lines into md', () => {
    const { segments, mentionedUser } = splitForCard('普通一行\n@小郑 看一下', targets)
    expect(mentionedUser).toBe(true)
    expect(segments.some((s) => s.kind === 'at' && s.text.includes('ou_user'))).toBe(true)
    expect(segments.some((s) => s.kind === 'md' && s.text.includes('普通一行'))).toBe(true)
  })

  it('keeps table rows inside a markdown segment (no @ split tearing the table)', () => {
    const { segments } = splitForCard('| a | b |\n| - | - |\n| 1 | 2 |', targets)
    expect(segments).toHaveLength(1)
    expect(segments[0]?.kind).toBe('md')
  })

  it('keeps fenced code blocks in markdown segments', () => {
    const { segments } = splitForCard('```\n@主案 in code\n```', targets)
    expect(segments.every((s) => s.kind === 'md')).toBe(true)
  })
})

describe('wantsUser', () => {
  it('matches an explicit @<userName>', () => {
    expect(wantsUser('请 @operator 验收', 'operator')).toBe(true)
  })

  it('matches the 【待 …】 attention marker', () => {
    expect(wantsUser('【待 operator:待确认】', 'operator')).toBe(true)
  })

  it('matches the generic @用户 marker', () => {
    expect(wantsUser('@用户 确认', 'operator')).toBe(true)
  })

  it('is false for ordinary progress text', () => {
    expect(wantsUser('proposer 正在审查代码', 'operator')).toBe(false)
  })
})
