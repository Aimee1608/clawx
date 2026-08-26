import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createTmuxOrchestrator } from './tmux-orchestrator.js'
import { TmuxSessionStore } from './tmux-session-store.js'

let tmpFile: string
beforeEach(() => {
  vi.useFakeTimers()
  tmpFile = path.join(os.tmpdir(), `clawx-test-orch-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
})
afterEach(() => {
  vi.useRealTimers()
  try {
    fs.rmSync(tmpFile, { force: true })
  } catch {
    /* ignore */
  }
})

/** `aliveByAttempt[i]` = 第 i 次 spawn 之后 hasSession 的返回值。 */
function fakeMgr(aliveByAttempt: boolean[]) {
  let attempt = -1
  const calls = { newSession: 0, killSession: 0 }
  const mgr = {
    async newSession() {
      attempt++
      calls.newSession++
    },
    async hasSession() {
      return aliveByAttempt[attempt] ?? false
    },
    async killSession() {
      calls.killSession++
    },
    async sendKeys() {},
    async sendKey() {},
    async capturePane() {
      return ''
    },
    async listSessions() {
      return []
    },
    async setSessionOption() {},
    async renameWindow() {},
  }
  return { mgr: mgr as any, calls }
}

function makeOrch(aliveByAttempt: boolean[]) {
  const store = new TmuxSessionStore({ persistPath: tmpFile })
  const { mgr, calls } = fakeMgr(aliveByAttempt)
  // codex: create() 跳过 claude 专属的 acceptStartupDialogs 30s 轮询
  const orch = createTmuxOrchestrator({ store, mgr })
  return { orch, store, calls }
}

const createCodex = (orch: any) =>
  orch.create({ sessionId: 'sid-1', cwd: '/tmp', agentKind: 'codex' })

describe('create() 存活校验', () => {
  it('进程稳住时一次就成功,不重试', async () => {
    const { orch, store, calls } = makeOrch([true])
    const p = createCodex(orch)
    await vi.advanceTimersByTimeAsync(5_000)
    const entry = await p
    expect(entry.sessionId).toBe('sid-1')
    expect(calls.newSession).toBe(1)
    expect(store.get('sid-1')).toBeTruthy()
  })

  it('启动即退出时自动重试一次,第二次活下来即成功', async () => {
    const { orch, store, calls } = makeOrch([false, true])
    const p = createCodex(orch)
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(p).resolves.toBeTruthy()
    expect(calls.newSession).toBe(2)
    expect(calls.killSession).toBeGreaterThanOrEqual(1)
    expect(store.get('sid-1')).toBeTruthy()
  })

  it('两次都启动即退出时抛错,且不留下 store 记录', async () => {
    const { orch, store, calls } = makeOrch([false, false])
    const p = createCodex(orch).catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(15_000)
    const err = await p
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/启动即退出/)
    expect(calls.newSession).toBe(2)
    // 关键回归:失败必须清干净,否则用户拿到一个"建好了"的空壳会话
    expect(store.get('sid-1')).toBeUndefined()
  })
})

describe('投递确认 watchdog', () => {
  function makeSendOrch(opts: { onSendKeys?: (orch: any) => void } = {}) {
    const store = new TmuxSessionStore({ persistPath: tmpFile })
    const warned: Array<{ sessionId: string; text: string }> = []
    let orch: any
    const mgr = {
      async newSession() {},
      async hasSession() {
        return true
      },
      async killSession() {},
      async sendKeys() {
        opts.onSendKeys?.(orch)
      },
      async sendKey() {},
      async capturePane() {
        return '❯ \n  ⏵⏵ bypass permissions on'
      },
      async listSessions() {
        return []
      },
      async setSessionOption() {},
      async renameWindow() {},
    }
    orch = createTmuxOrchestrator({
      store,
      mgr: mgr as any,
      deliveryConfirmMs: 1000,
      onDeliveryUnconfirmed: (info) => warned.push({ sessionId: info.sessionId, text: info.text }),
    })
    store.upsert({
      sessionId: 'sid-1',
      tmuxName: 'clawx-sid-1',
      cwd: '/tmp',
      agentKind: 'claude',
      createdAt: new Date().toISOString(),
    } as any)
    return { orch, warned }
  }

  it('turn-done 兜底:turn-start 丢了也不该警告已被回复的消息', async () => {
    const { orch, warned } = makeSendOrch()
    await orch.send('sid-1', 'hi', 'lark')
    // turn-start 从未到达(hook 丢了),但这一轮正常跑完
    orch.confirmDelivered('sid-1')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(warned).toEqual([])
  })

  it('turn-start 在 sendKeys 期间到达也能取消(arm 早于 send 的竞态)', async () => {
    const { orch, warned } = makeSendOrch({
      onSendKeys: (o) => o.confirmTurnStarted('sid-1'),
    })
    await orch.send('sid-1', 'hi', 'lark')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(warned).toEqual([])
  })

  it('真的没人认领时仍然警告', async () => {
    const { orch, warned } = makeSendOrch()
    await orch.send('sid-1', 'hi', 'lark')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(warned).toHaveLength(1)
    expect(warned[0]!.text).toBe('hi')
  })
})
