import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createTmuxMgr } from './tmux-mgr.js'

describe('tmux bracketed paste delivery', () => {
  it.each([32, 25000])('preserves %s repeats, newlines and exactly one submit', async (repeats) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clawx-mgr-test-'))
    const socket = `clawx-test-${randomUUID()}`
    const wrapper = path.join(directory, 'tmux')
    const ready = path.join(directory, 'ready')
    const received = path.join(directory, 'received')
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec tmux -L '${socket}' "$@"\n`, { mode: 0o700 })
    const receiver = path.join(directory, 'receiver.cjs')
    fs.writeFileSync(receiver, `
      const fs = require('node:fs');
      process.stdin.setRawMode(true);
      process.stdout.write('\\x1b[?2004h');
      let bytes = Buffer.alloc(0);
      process.stdin.on('data', chunk => {
        bytes = Buffer.concat([bytes, chunk]);
        fs.writeFileSync(${JSON.stringify(received)}, bytes);
      });
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
    `)
    const mgr = createTmuxMgr({ tmuxCmd: wrapper })
    try {
      await mgr.newSession({ name: 'test', cwd: directory, cmd: `${process.execPath} ${receiver}` })
      await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true))
      const text = '-中文🙂填充'.repeat(repeats) + '\n第二行\n结束标记'
      await mgr.sendKeys({ name: 'test', text, pressEnter: true, bracketedPaste: true })
      await vi.waitFor(() => {
        expect(fs.readFileSync(received, 'utf8')).toBe(`\x1b[200~${text}\x1b[201~\r`)
      })
      const buffers = execFileSync(wrapper, ['list-buffers'], { encoding: 'utf8' })
      expect(buffers).not.toContain('clawx-')
    } finally {
      execFileSync('tmux', ['-L', socket, 'kill-server'])
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }, 15000)
})

it('retains stderr from an exited agent and reports the process as dead', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clawx-exit-test-'))
  const socket = `clawx-exit-${randomUUID()}`
  const wrapper = path.join(directory, 'tmux')
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec tmux -L '${socket}' "$@"\n`, { mode: 0o700 })
  const mgr = createTmuxMgr({ tmuxCmd: wrapper })
  try {
    await mgr.newSession({ name: 'failed', cwd: directory, retainOnExit: true,
      cmd: "sleep 0.1; printf 'Error: model catalog request timed out\\n' >&2; exit 7" })
    await vi.waitFor(async () => expect(await mgr.hasSession('failed')).toBe(false))
    expect(await mgr.capturePane({ name: 'failed' })).toContain('model catalog request timed out')
    expect(execFileSync(wrapper, ['display-message', '-p', '-t', 'failed', '#{pane_dead_status}'], { encoding: 'utf8' }).trim()).toBe('7')
    await mgr.setSessionOption({ name: 'failed', option: 'remain-on-exit', value: 'failed' })
    expect(execFileSync(wrapper, ['show-options', '-w', '-t', 'failed', 'remain-on-exit'], { encoding: 'utf8' })).toContain('failed')
  } finally {
    execFileSync('tmux', ['-L', socket, 'kill-server'])
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
