import fs from 'node:fs'
import https from 'node:https'
import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto'
import { log } from './logger.js'

export interface ClaudeQuotaConfig {
  baseUrl: string
  apiKey: string
  caFile?: string
}

interface QuotaWindow {
  kind?: string
  scope?: string
  used_ratio?: number
  resets_at?: string
}

interface QuotaAccount {
  account_id?: string
  provider?: string
  state?: string
  windows?: QuotaWindow[]
}

function remaining(windows: QuotaWindow[], kind: string): string {
  const ratio = windows.find((w) => w.kind === kind && w.scope !== 'model')?.used_ratio
  return typeof ratio === 'number' && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1
    ? `${Math.round((1 - ratio) * 100)}%`
    : '未知'
}

function resetIn(windows: QuotaWindow[], now: number): string {
  const reset = Date.parse(windows.find((w) => w.kind === 'five_hour' && w.scope !== 'model')?.resets_at ?? '')
  if (!Number.isFinite(reset)) return '重置时间未知'
  if (reset <= now) return '重置时间待刷新'
  const minutes = Math.ceil((reset - now) / 60_000)
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours}小时${minutes % 60}分后重置` : `${minutes}分钟后重置`
}

export function formatClaudeQuota(report: unknown, now = Date.now()): string {
  const data = report as { account_quota_shared?: boolean; accounts?: QuotaAccount[] }
  if (!data || typeof data !== 'object') throw new Error('invalid quota report')
  if (data.account_quota_shared === false) return '额度未共享'
  if (!Array.isArray(data.accounts)) throw new Error('missing quota accounts')
  const accounts = data.accounts.filter((a) => a?.provider?.toLowerCase() === 'claude')
    .sort((a, b) => (a.account_id ?? '').localeCompare(b.account_id ?? ''))
  if (!accounts.length) return '暂无 Claude 账号额度'
  const states: Record<string, string> = {
    cooldown: '冷却中', exhausted: '额度耗尽', restricted: '受限', unavailable: '不可用',
  }
  return '剩余额度：' + accounts.map((a, i) => {
    const windows = Array.isArray(a.windows) ? a.windows : []
    const state = a.state === 'available' ? '' : `（${states[a.state ?? ''] ?? '状态未知'}）`
    return `账号${i + 1}${state} 5h ${remaining(windows, 'five_hour')}（${resetIn(windows, now)}） / 周${remaining(windows, 'weekly')}`
  }).join('；')
}

export function createClaudeQuotaClient(config?: ClaudeQuotaConfig): {
  signature(): Promise<string | undefined>
} {
  const cookies = new Map<string, string>()
  let pending: Promise<string> | undefined

  async function load(): Promise<string> {
    const origin = new URL(config!.baseUrl).origin
    if (!origin.startsWith('https://')) throw new Error('quota endpoint requires HTTPS')
    const ca = config!.caFile ? fs.readFileSync(config!.caFile) : undefined
    const signal = AbortSignal.timeout(2000)

    function request(route: string, body?: unknown): Promise<{ status: number; data: any }> {
      return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body)
        const req = https.request(new URL(route, origin), {
          method: payload === undefined ? 'GET' : 'POST', ca, family: 4, signal, rejectUnauthorized: true,
          headers: {
            accept: 'application/json', origin, 'x-usage-client': '1', 'x-usage-origin': origin,
            cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
            ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
          },
        }, (res) => {
          for (const cookie of res.headers['set-cookie'] ?? []) {
            const pair = cookie.split(';')[0] ?? ''
            const separator = pair.indexOf('=')
            if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1))
          }
          let raw = ''
          res.setEncoding('utf8')
          res.on('error', reject)
          res.on('data', (chunk: string) => {
            raw += chunk
            if (raw.length > 1_048_576) req.destroy(new Error('quota response too large'))
          })
          res.on('end', () => {
            try { resolve({ status: res.statusCode ?? 0, data: raw ? JSON.parse(raw) : null }) }
            catch { reject(new Error('invalid quota response')) }
          })
        })
        req.on('error', reject)
        if (payload !== undefined) req.write(payload)
        req.end()
      })
    }

    async function authenticate(): Promise<void> {
      const response = await request('/usage-session/challenge', {})
      const challenge = response.data
      if (response.status !== 200 || !/^[a-f0-9]{64}$/.test(challenge?.challenge) || typeof challenge?.public_key !== 'string') {
        throw new Error('invalid quota challenge')
      }
      const key = randomBytes(32)
      const iv = randomBytes(12)
      const header = Buffer.from('{"alg":"RSA-OAEP-256","enc":"A256GCM"}').toString('base64url')
      const plaintext = Buffer.from(JSON.stringify({ key: config!.apiKey, challenge: challenge.challenge, origin }))
      try {
        const publicKey = createPublicKey({ key: Buffer.from(challenge.public_key, 'base64url'), format: 'der', type: 'spki' })
        const encryptedKey = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key)
        const cipher = createCipheriv('aes-256-gcm', key, iv)
        cipher.setAAD(Buffer.from(header))
        const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
        const jwe = [header, encryptedKey.toString('base64url'), iv.toString('base64url'), encrypted.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.')
        const login = await request('/usage-session/login', { challenge: challenge.challenge, jwe })
        if (login.status < 200 || login.status >= 300) throw new Error('quota login failed')
      } finally {
        key.fill(0)
        plaintext.fill(0)
      }
    }

    if (!cookies.size) await authenticate()
    let report = await request('/usage-session/report?timezone=Asia%2FShanghai')
    if (report.status === 401) {
      cookies.clear()
      await authenticate()
      report = await request('/usage-session/report?timezone=Asia%2FShanghai')
    }
    if (report.status !== 200) throw new Error(`quota report HTTP ${report.status}`)
    return formatClaudeQuota(report.data)
  }

  return {
    async signature() {
      if (!config?.baseUrl?.trim() || !config.apiKey?.trim()) return undefined
      pending ??= load().catch(() => {
        cookies.clear()
        log.warn('Claude quota lookup unavailable')
        return '额度暂不可用'
      }).finally(() => { pending = undefined })
      return pending
    },
  }
}
