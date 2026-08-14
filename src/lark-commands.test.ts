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
