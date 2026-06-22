import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { SessionStore } from './session-store.js'

let tmpFile: string
beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `clawx-test-sess-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
})
afterEach(() => {
  try {
    fs.rmSync(tmpFile, { force: true })
  } catch {
    /* ignore */
  }
})

describe('getOrCreateClaudeUuid (DM session binding)', () => {
  it('mints a fresh uuid on the first message (isNew=true)', () => {
    const s = new SessionStore()
    const r = s.getOrCreateClaudeUuid('chat:a')
    expect(r.isNew).toBe(true)
    expect(r.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i)
  })

  it('reuses the same uuid on subsequent messages (isNew=false) + counts turns', () => {
    const s = new SessionStore()
    const first = s.getOrCreateClaudeUuid('chat:a')
    const second = s.getOrCreateClaudeUuid('chat:a')
    expect(second.isNew).toBe(false)
    expect(second.uuid).toBe(first.uuid)
    expect(s.get('chat:a')?.messageCount).toBe(2)
  })

  it('gives different chats different uuids', () => {
    const s = new SessionStore()
    const a = s.getOrCreateClaudeUuid('chat:a').uuid
    const b = s.getOrCreateClaudeUuid('chat:b').uuid
    expect(a).not.toBe(b)
  })
})

describe('/new rotation (markNewForNext)', () => {
  it('rotates a single session to a fresh uuid on its next message', () => {
    const s = new SessionStore()
    const u1 = s.getOrCreateClaudeUuid('chat:a').uuid
    s.markNewForNext('chat:a')
    const r2 = s.getOrCreateClaudeUuid('chat:a')
    expect(r2.isNew).toBe(true)
    expect(r2.uuid).not.toBe(u1)
  })

  it('with no arg rotates every session', () => {
    const s = new SessionStore()
    s.getOrCreateClaudeUuid('chat:a')
    s.getOrCreateClaudeUuid('chat:b')
    s.markNewForNext()
    expect(s.getOrCreateClaudeUuid('chat:a').isNew).toBe(true)
    expect(s.getOrCreateClaudeUuid('chat:b').isNew).toBe(true)
  })
})

describe('/resume rebind (setClaudeUuid)', () => {
  it('rebinds to an explicit uuid; next message resumes it (isNew=false)', () => {
    const s = new SessionStore()
    s.getOrCreateClaudeUuid('chat:a')
    s.setClaudeUuid('chat:a', 'explicit-uuid')
    const r = s.getOrCreateClaudeUuid('chat:a')
    expect(r.isNew).toBe(false)
    expect(r.uuid).toBe('explicit-uuid')
  })

  it('supersedes a queued /new (resume wins over rotate)', () => {
    const s = new SessionStore()
    s.getOrCreateClaudeUuid('chat:a')
    s.markNewForNext('chat:a')
    s.setClaudeUuid('chat:a', 'explicit-uuid')
    expect(s.getOrCreateClaudeUuid('chat:a').uuid).toBe('explicit-uuid')
  })
})

describe('persistence', () => {
  it('persists the binding across instances when persistPath is set', () => {
    const a = new SessionStore({ persistPath: tmpFile })
    const u = a.getOrCreateClaudeUuid('chat:a').uuid
    const b = new SessionStore({ persistPath: tmpFile })
    const r = b.getOrCreateClaudeUuid('chat:a')
    expect(r.isNew).toBe(false)
    expect(r.uuid).toBe(u)
  })

  it('stays purely in-memory (writes no file) without persistPath', () => {
    const s = new SessionStore()
    s.getOrCreateClaudeUuid('chat:a')
    expect(fs.existsSync(tmpFile)).toBe(false)
  })

  it('tolerates a corrupt persist file (starts empty)', () => {
    fs.writeFileSync(tmpFile, '{bad json')
    const s = new SessionStore({ persistPath: tmpFile })
    expect(s.size()).toBe(0)
    expect(s.getOrCreateClaudeUuid('chat:a').isNew).toBe(true)
  })
})

describe('clear / size', () => {
  it('size reflects count and clear empties', () => {
    const s = new SessionStore()
    s.getOrCreateClaudeUuid('chat:a')
    s.getOrCreateClaudeUuid('chat:b')
    expect(s.size()).toBe(2)
    s.clear()
    expect(s.size()).toBe(0)
  })
})
