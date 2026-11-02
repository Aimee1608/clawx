import { describe, expect, it } from 'vitest'

import { buildBotReplyCard, formatSeedText, sourceLabel } from './seed-text.js'

describe('sourceLabel', () => {
  it('labels each send source (cli carries the clawx brand — rebrand check)', () => {
    expect(sourceLabel('web')).toBe('web')
    expect(sourceLabel('cli')).toBe('终端 (xclaw tmux)')
    expect(sourceLabel('lark')).toBe('Lark')
    expect(sourceLabel('terminal')).toBe('终端 (直敲)')
    expect(sourceLabel('unknown')).toBe('未知')
  })
})

describe('formatSeedText', () => {
  const base = { cwd: '/home/u/proj', sessionId: 'sid123', creator: 'cli' as const }

  it('uses an explicit label as the title, else basename(cwd)', () => {
    expect(formatSeedText({ ...base, label: '我的会话' })).toContain('🆕 我的会话')
    expect(formatSeedText(base)).toContain('🆕 proj')
  })

  it('marks resumed sessions with ♻️ instead of 🆕', () => {
    const s = formatSeedText({ ...base, resumed: true })
    expect(s).toContain('♻️')
    expect(s).not.toContain('🆕')
  })

  it('defaults the tmux attach name to clawx-<sid> (rebrand check)', () => {
    expect(formatSeedText(base)).toContain('tmux attach -t clawx-sid123')
  })

  it('honors an explicit tmuxName', () => {
    expect(formatSeedText({ ...base, tmuxName: 'clawx-custom' })).toContain('tmux attach -t clawx-custom')
  })

  it('shows the project dir name on its own line (which project is this?)', () => {
    const s = formatSeedText({ ...base, label: '我的会话' })
    expect(s).toContain('📦 proj')
    expect(s).not.toContain('来自')
  })

  it('keeps the resume tag on the time line', () => {
    expect(formatSeedText({ ...base, resumed: true })).toMatch(/🕒 .* · 续接/)
    expect(formatSeedText(base)).not.toContain('续接')
  })

  it('includes cwd / sid / agent metadata lines', () => {
    const s = formatSeedText({ ...base, agentKind: 'codex', agentSessionId: 'uuid-x' })
    expect(s).toContain('📁 /home/u/proj')
    expect(s).toContain('🆔 sid: sid123')
    expect(s).toContain('🤖 agent: codex')
    expect(s).toContain('codex: uuid-x')
  })

  it('appends an <at> mention line only when mentionOpenId is given', () => {
    expect(formatSeedText({ ...base, mentionOpenId: 'ou_x' })).toContain('<at user_id="ou_x"></at>')
    expect(formatSeedText(base)).not.toContain('<at')
  })
})

describe('final response attribution', () => {
  it.each([
    ['codex', 'gpt-6.1-sol', 'Codex'],
    ['claude', 'claude-opus-4-6', 'Claude Code'],
  ] as const)('appends a subtle footer for %s', (agentKind, model, label) => {
    const card = buildBotReplyCard({ text: '最终结果', agentKind, model, cwd: '/workspace/团队项目/migrate-tools/' }) as any
    expect(card.body.elements).toEqual([
      { tag: 'markdown', content: '最终结果' },
      { tag: 'markdown', text_size: 'notation', content: `<font color='grey'>migrate-tools · ${label} · ${model}</font>` },
    ])
    const progress = buildBotReplyCard({ text: '检查中', agentKind, model, cwd: '/workspace/migrate-tools', intermediate: true }) as any
    expect(progress.body.elements).toHaveLength(1)
  })

  it('keeps the footer after truncation and marks unknown models without guessing', () => {
    const card = buildBotReplyCard({ text: '长'.repeat(9000), agentKind: 'codex' }) as any
    expect(card.body.elements[0].content).toContain('已截断')
    expect(card.body.elements.at(-1).content).toContain('Codex · 模型未识别')
    const escaped = buildBotReplyCard({ text: '结果', agentKind: 'codex', model: '<at id=all>' }) as any
    expect(escaped.body.elements.at(-1).content).not.toContain('<at')
  })
})
