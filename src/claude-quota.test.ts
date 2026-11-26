import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import { constants, createDecipheriv, createPublicKey, privateDecrypt } from 'node:crypto'
import { once } from 'node:events'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createClaudeQuotaClient, formatClaudeQuota } from './claude-quota.js'
import { buildBotReplyCard } from './seed-text.js'

const report = (used = 0.41) => ({ accounts: [
  { account_id: 'b', provider: 'claude', state: 'available',
    windows: [{ kind: 'five_hour', used_ratio: 0.35 }, { kind: 'weekly', used_ratio: 0.56 }] },
  { account_id: 'a', provider: 'claude', state: 'available',
    windows: [{ kind: 'five_hour', used_ratio: used }, { kind: 'weekly', used_ratio: 0.74 }] },
] })

describe('Claude quota formatting', () => {
  it('keeps each Claude account separate and orders them consistently', () => {
    expect(formatClaudeQuota(report())).toBe('剩余额度：账号1 5h 59%（重置时间未知） / 周26%；账号2 5h 65%（重置时间未知） / 周44%')
  })

  it('marks unknown quotas and unavailable accounts without substituting scoped quotas', () => {
    expect(formatClaudeQuota({ accounts: [
      { account_id: 'a', provider: 'claude', state: 'cooldown', windows: [
        { kind: 'weekly', scope: 'model', used_ratio: 0 },
        { kind: 'five_hour', used_ratio: 1 },
      ] },
      { account_id: 'c', provider: 'codex', state: 'available', windows: [] },
    ] })).toBe('剩余额度：账号1（冷却中） 5h 0%（重置时间未知） / 周未知')
    expect(formatClaudeQuota({ accounts: [{ provider: 'claude', windows: [{ kind: 'five_hour', used_ratio: -1 }] }] })).toContain('5h 未知')
    expect(formatClaudeQuota({ account_quota_shared: false })).toBe('额度未共享')
  })

  it.each([
    ['2026-11-18T01:00:00+08:00', '3小时49分后重置'],
    ['2026-11-17T21:41:00+08:00', '30分钟后重置'],
    ['2026-11-17T21:11:01+08:00', '1分钟后重置'],
    ['2026-11-17T21:00:00+08:00', '重置时间待刷新'],
    ['invalid', '重置时间未知'],
  ])('formats the five-hour reset at %s', (resets_at, expected) => {
    const data = { accounts: [{ provider: 'claude', state: 'available', windows: [
      { kind: 'five_hour', scope: 'model', resets_at: '2026-11-18T05:00:00+08:00' },
      { kind: 'five_hour', used_ratio: 0.41, resets_at },
    ] }] }
    expect(formatClaudeQuota(data, Date.parse('2026-11-17T21:11:00+08:00'))).toContain(`5h 59%（${expected}）`)
  })
})

describe('AsterGate read-only quota session', () => {
  let dir: string
  let privateKey: Buffer
  let cert: Buffer
  let publicKey: string
  let caFile: string

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawx-quota-'))
    const keyFile = path.join(dir, 'key.pem')
    caFile = path.join(dir, 'cert.pem')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout', keyFile, '-out', caFile], { stdio: 'ignore' })
    privateKey = fs.readFileSync(keyFile)
    cert = fs.readFileSync(caFile)
    publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64url')
  })
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  async function gateway() {
    const state = { logins: 0, reports: 0, session: 0, used: 0.41, fail: false, hang: false }
    const requests: string[] = []
    const decoded: any[] = []
    const server = https.createServer({ key: privateKey, cert }, async (req, res) => {
      requests.push(`${req.method} ${req.url}`)
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(data))
      }
      if (req.url === '/usage-session/challenge') {
        json(200, { challenge: 'ab'.repeat(32), public_key: publicKey })
      } else if (req.url === '/usage-session/login') {
        let raw = ''
        for await (const chunk of req) raw += chunk
        const payload = JSON.parse(raw)
        const parts = payload.jwe.split('.')
        const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256' }, Buffer.from(parts[1], 'base64url'))
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[2], 'base64url'))
        decipher.setAAD(Buffer.from(parts[0]))
        decipher.setAuthTag(Buffer.from(parts[4], 'base64url'))
        decoded.push(JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString()))
        state.logins++
        res.writeHead(204, { 'set-cookie': `usage=session-${++state.session}; Secure; HttpOnly; Path=/usage-session` })
        res.end()
      } else if (req.url === '/usage-session/report?timezone=Asia%2FShanghai') {
        state.reports++
        if (state.hang) return
        if (req.headers.cookie !== `usage=session-${state.session}`) { json(401, {}); return }
        json(state.fail ? 503 : 200, state.fail ? {} : report(state.used))
      } else {
        json(404, {})
      }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as { port: number }
    const config = { baseUrl: `https://127.0.0.1:${port}`, apiKey: 'test-private-key', caFile }
    return { state, requests, decoded, config, close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    } }
  }

  it('authenticates with encrypted credentials, reuses the session and reads fresh quotas per reply', async () => {
    const g = await gateway()
    try {
      const client = createClaudeQuotaClient(g.config)
      expect(await client.signature()).toContain('5h 59%')
      expect(g.decoded[0]).toEqual({ key: g.config.apiKey, challenge: 'ab'.repeat(32), origin: g.config.baseUrl })
      g.state.used = 0.6
      expect(await client.signature()).toContain('5h 40%')
      expect(g.state.logins).toBe(1)
      expect(g.state.reports).toBe(2)
      expect(g.requests.join(' ')).not.toContain(g.config.apiKey)
      expect(g.requests.every((r) => r.includes('/usage-session/'))).toBe(true)
    } finally { await g.close() }
  })

  it('shares concurrent lookups and renews an expired session', async () => {
    const g = await gateway()
    try {
      const client = createClaudeQuotaClient(g.config)
      const signatures = await Promise.all([client.signature(), client.signature(), client.signature()])
      expect(new Set(signatures).size).toBe(1)
      expect(g.state.reports).toBe(1)
      g.state.session++
      expect(await client.signature()).toContain('5h 59%')
      expect(g.state.logins).toBe(2)
      expect(g.state.reports).toBe(3)
    } finally { await g.close() }
  })

  it('replaces a previous reading with an unavailable marker when the gateway fails', async () => {
    const g = await gateway()
    try {
      const client = createClaudeQuotaClient(g.config)
      expect(await client.signature()).toContain('59%')
      g.state.fail = true
      const quotaSummary = await client.signature()
      expect(quotaSummary).toBe('额度暂不可用')
      const card = buildBotReplyCard({ text: '原始回复', agentKind: 'claude', quotaSummary }) as any
      expect(card.body.elements[0].content).toBe('原始回复')
      expect(card.body.elements.at(-1).content).not.toContain('59%')
      g.state.fail = false
      expect(await client.signature()).toContain('59%')
    } finally { await g.close() }
  })

  it('bounds the complete lookup to two seconds and requires the configured CA', async () => {
    const g = await gateway()
    const warning = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect(await createClaudeQuotaClient({ ...g.config, caFile: undefined }).signature()).toBe('额度暂不可用')
      g.state.hang = true
      const start = Date.now()
      expect(await createClaudeQuotaClient(g.config).signature()).toBe('额度暂不可用')
      expect(Date.now() - start).toBeLessThan(3500)
      expect(await createClaudeQuotaClient().signature()).toBeUndefined()
    } finally { warning.mockRestore(); await g.close() }
  })
})
