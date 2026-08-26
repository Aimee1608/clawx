import { describe, expect, it } from 'vitest'

import { parseNewSoloCommand } from './lark-commands.js'

describe('parseNewSoloCommand', () => {
  it('matches /new-solo with an alias + label', () => {
    expect(parseNewSoloCommand('/new-solo riff 修登录bug', { inThread: true })).toEqual({
      rest: 'riff 修登录bug',
    })
  })

  it('keeps /new as an equivalent alias', () => {
    for (const inThread of [true, false]) {
      expect(parseNewSoloCommand('/new riff', { inThread })).toEqual({ rest: 'riff' })
      expect(parseNewSoloCommand('/new-solo riff', { inThread })).toEqual({ rest: 'riff' })
    }
  })

  it('returns an empty rest with no argument (→ alias listing)', () => {
    expect(parseNewSoloCommand('/new-solo', { inThread: true })).toEqual({ rest: '' })
    expect(parseNewSoloCommand('  /new  ', { inThread: false })).toEqual({ rest: '' })
  })

  it('accepts /new-tmux <path> in a thread only — the DM chain has its own branch', () => {
    expect(parseNewSoloCommand('/new-tmux /a/b 标题', { inThread: true })).toEqual({
      rest: '/a/b 标题',
    })
    expect(parseNewSoloCommand('/new-tmux /a/b 标题', { inThread: false })).toBeNull()
  })

  it('does not fire on a sentence that merely mentions the command', () => {
    expect(parseNewSoloCommand('顺便 /new riff 一下', { inThread: true })).toBeNull()
    expect(parseNewSoloCommand('看看 /new-solo 怎么用', { inThread: true })).toBeNull()
  })

  it('does not fire on lookalike words', () => {
    for (const s of ['/newfoo', '/new-solox', '/news riff', '/new_solo riff']) {
      expect(parseNewSoloCommand(s, { inThread: true })).toBeNull()
    }
  })

  it('leaves /clear alone so it still reaches the REPL', () => {
    expect(parseNewSoloCommand('/clear', { inThread: true })).toBeNull()
  })
})

const { buildImagePrompt } = await import('./ws-main.js')

describe('buildImagePrompt', () => {
  it('纯图片时末尾留空格,否则 @ 补全菜单吞掉 Enter', () => {
    const out = buildImagePrompt(['/imgs/a.jpg'], '')
    expect(out).toBe('@/imgs/a.jpg ')
    expect(out.endsWith(' ')).toBe(true)
  })

  it('多图无正文时同样留尾空格', () => {
    expect(buildImagePrompt(['/imgs/a.jpg', '/imgs/b.jpg'], '')).toBe('@/imgs/a.jpg @/imgs/b.jpg ')
  })

  it('带正文时正文在后,不需要补空格', () => {
    expect(buildImagePrompt(['/imgs/a.jpg'], '看看这个')).toBe('@/imgs/a.jpg 看看这个')
  })

  it('只有空白正文按无正文处理', () => {
    expect(buildImagePrompt(['/imgs/a.jpg'], '   ')).toBe('@/imgs/a.jpg ')
  })

  it('无图片时原样返回,不加尾空格', () => {
    expect(buildImagePrompt([], '纯文本')).toBe('纯文本')
  })
})
