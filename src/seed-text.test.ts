import { describe, expect, it } from 'vitest'

import { formatSeedText, sourceLabel } from './seed-text.js'

describe('sourceLabel', () => {
  it('labels each send source (cli carries the clawx brand — rebrand check)', () => {
    expect(sourceLabel('web')).toBe('web')
    expect(sourceLabel('cli')).toBe('终端 (clawx tmux)')
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
