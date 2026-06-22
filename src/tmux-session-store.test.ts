import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { TmuxSessionStore, type TmuxSessionEntry } from './tmux-session-store.js'

// Isolated temp file per test — never touches the operator's real store.
let tmpFile: string
beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `clawx-test-tmux-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
})
afterEach(() => {
  try {
    fs.rmSync(tmpFile, { force: true })
  } catch {
    /* ignore */
  }
})

function mk(sessionId: string, over: Partial<TmuxSessionEntry> = {}): TmuxSessionEntry {
  return {
    sessionId,
    tmuxName: `clawx-${sessionId}`,
    cwd: '/tmp/x',
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

describe('TmuxSessionStore', () => {
  it('upsert + get round-trips an entry', () => {
    const s = new TmuxSessionStore({ persistPath: tmpFile })
    s.upsert(mk('s1'))
    expect(s.get('s1')?.tmuxName).toBe('clawx-s1')
  })

  it('upsert replaces an existing entry (no duplicates)', () => {
    const s = new TmuxSessionStore({ persistPath: tmpFile })
    s.upsert(mk('s1', { label: 'old' }))
    s.upsert(mk('s1', { label: 'new' }))
    expect(s.entries()).toHaveLength(1)
    expect(s.get('s1')?.label).toBe('new')
  })

  it('indexes by tmuxName / claudeUuid / threadId', () => {
    const s = new TmuxSessionStore({ persistPath: tmpFile })
    s.upsert(mk('s1', { claudeUuid: 'uuid-1', threadId: 'omt_1' }))
    expect(s.getByTmuxName('clawx-s1')?.sessionId).toBe('s1')
    expect(s.getByClaudeUuid('uuid-1')?.sessionId).toBe('s1')
    expect(s.getByThreadId('omt_1')?.sessionId).toBe('s1')
  })

  it('patch merges fields and keeps sessionId; throws on unknown id', () => {
    const s = new TmuxSessionStore({ persistPath: tmpFile })
    s.upsert(mk('s1'))
    const p = s.patch('s1', { label: 'patched' })
    expect(p.label).toBe('patched')
    expect(p.tmuxName).toBe('clawx-s1') // untouched fields survive
    expect(() => s.patch('nope', {})).toThrow()
  })

  it('remove deletes and returns a boolean', () => {
    const s = new TmuxSessionStore({ persistPath: tmpFile })
    s.upsert(mk('s1'))
    expect(s.remove('s1')).toBe(true)
    expect(s.get('s1')).toBeUndefined()
    expect(s.remove('s1')).toBe(false)
  })

  it('persists across instances (flush + reload from disk)', () => {
    const a = new TmuxSessionStore({ persistPath: tmpFile })
    a.upsert(mk('s1', { label: 'persisted' }))
    const b = new TmuxSessionStore({ persistPath: tmpFile })
    expect(b.get('s1')?.label).toBe('persisted')
  })

  it('normalizes a claude entry: agentKind=claude, agentSessionId from claudeUuid', () => {
    const s = new TmuxSessionStore({ persistPath: tmpFile })
    s.upsert(mk('s1', { claudeUuid: 'uuid-1' }))
    const e = s.get('s1')!
    expect(e.agentKind).toBe('claude')
    expect(e.agentSessionId).toBe('uuid-1')
    expect(s.getByAgentSession('claude', 'uuid-1')?.sessionId).toBe('s1')
  })

  it('tracks a codex entry under its own agentKey', () => {
    const s = new TmuxSessionStore({ persistPath: tmpFile })
    s.upsert(mk('s2', { agentKind: 'codex', agentSessionId: 'cx-1' }))
    expect(s.getByAgentSession('codex', 'cx-1')?.sessionId).toBe('s2')
  })

  it('clear empties the store', () => {
    const s = new TmuxSessionStore({ persistPath: tmpFile })
    s.upsert(mk('s1'))
    s.upsert(mk('s2'))
    s.clear()
    expect(s.entries()).toHaveLength(0)
  })

  it('tolerates a corrupt store file (starts fresh)', () => {
    fs.writeFileSync(tmpFile, '{not valid json')
    const s = new TmuxSessionStore({ persistPath: tmpFile })
    expect(s.entries()).toHaveLength(0)
    s.upsert(mk('s1'))
    expect(s.get('s1')).toBeDefined()
  })
})
