import { describe, expect, it } from 'vitest'

import { buildLeadPrompt, parseTemplate } from './templates.js'

describe('parseTemplate', () => {
  it('parses description + body from frontmatter', () => {
    const r = parseTemplate('---\ndescription: 开发场景\n---\n正文内容')
    expect(r.description).toBe('开发场景')
    expect(r.body).toBe('正文内容')
    expect(r.codexReview).toBe(false)
  })

  it('detects codexReview: true (A1 switch)', () => {
    const r = parseTemplate('---\ndescription: x\ncodexReview: true\n---\nbody')
    expect(r.codexReview).toBe(true)
  })

  it('defaults codexReview to false when the key is absent', () => {
    expect(parseTemplate('---\ndescription: x\n---\nbody').codexReview).toBe(false)
  })

  it('is case-insensitive on the codexReview value', () => {
    expect(parseTemplate('---\ncodexReview: TRUE\n---\nb').codexReview).toBe(true)
  })

  it('treats a file without frontmatter as all body', () => {
    const r = parseTemplate('就是正文,没有 frontmatter')
    expect(r.description).toBe('')
    expect(r.codexReview).toBe(false)
    expect(r.body).toBe('就是正文,没有 frontmatter')
  })
})

describe('buildLeadPrompt', () => {
  it('with a topic: bakes in mechanism + scene + discipline + kickoff gate', () => {
    const p = buildLeadPrompt({
      sceneBody: '场景:审查代码',
      teamName: 'room-x',
      userName: '小郑',
      topic: '看下这段代码',
    })
    expect(p).toContain('room-x') // mechanism: team name
    expect(p).toContain('proposer') // mechanism: fixed teammate names
    expect(p).toContain('challenger')
    expect(p).toContain('场景:审查代码') // scene layer
    expect(p).toContain('开工确认门') // discipline footer
    expect(p).toContain('小郑') // userName substituted in
    expect(p).toContain('议题:看下这段代码') // topic opener
  })

  it('standby (no topic): tells the lead to wait for the user to describe it', () => {
    const p = buildLeadPrompt({ sceneBody: 's', teamName: 'room-y', userName: 'U' })
    expect(p).toContain('待命')
    expect(p).not.toContain('议题:看下这段代码')
  })

  it('substitutes {{userName}} / {{teamName}} placeholders in the scene body', () => {
    const p = buildLeadPrompt({
      sceneBody: '{{userName}} 在 {{teamName}} 里干活',
      teamName: 'TM',
      userName: 'operator',
      topic: 't',
    })
    expect(p).toContain('operator 在 TM 里干活')
  })
})
