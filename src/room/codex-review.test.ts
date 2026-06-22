import { describe, expect, it } from 'vitest'

import { parseVerdict } from './codex-review.js'

describe('parseVerdict', () => {
  it('parses a PASS verdict', () => {
    expect(parseVerdict('看起来没问题\n\nVERDICT: PASS')).toBe('PASS')
  })

  it('parses a BLOCK verdict', () => {
    expect(parseVerdict('有 P0 硬伤\n\nVERDICT: BLOCK')).toBe('BLOCK')
  })

  it('is case-insensitive and tolerant of spacing', () => {
    expect(parseVerdict('verdict:pass')).toBe('PASS')
    expect(parseVerdict('VERDICT:   BLOCK')).toBe('BLOCK')
  })

  it('lets BLOCK win when both markers appear (fail-safe)', () => {
    expect(parseVerdict('一开始想 VERDICT: PASS,但复核后 VERDICT: BLOCK')).toBe('BLOCK')
  })

  it('returns UNKNOWN when no verdict line is present', () => {
    expect(parseVerdict('codex 只是闲聊,没有给裁决')).toBe('UNKNOWN')
  })
})
