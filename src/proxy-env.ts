import { log } from './logger.js'

/**
 * Force a known-good proxy into process.env at startup.
 *
 * Why: both the spawned `claude` CLI (agent-runner.ts) and the
 * `@anthropic-ai/claude-agent-sdk` `query()` calls inherit process.env
 * when reaching api.anthropic.com. If clawx is launched from a shell
 * that didn't source the user's proxy config — or inherited an unwanted
 * system / corporate proxy — Anthropic traffic silently goes the wrong
 * way. Normalizing here gives every entry point the same guarantee
 * regardless of parent shell state.
 *
 * Behavior: HTTP/SOCKS proxy vars are written when unset. To FORCE-replace
 * a specific inherited proxy (e.g. a corporate proxy your shell injects),
 * set CLAWX_OVERRIDE_PROXY_PATTERN to a regex matching its host/port —
 * inherited values matching it get replaced with the default target.
 *
 * Escape hatches:
 *   CLAWX_DISABLE_PROXY_INJECT=1       Skip entirely.
 *   CLAWX_PROXY_URL=<url>              Override the http(s) proxy target.
 *   CLAWX_NO_PROXY=<list>              Override the no_proxy list.
 *   CLAWX_OVERRIDE_PROXY_PATTERN=<re>  Force-replace inherited proxies
 *                                        whose value matches this regex.
 */

const DEFAULT_HTTP_PROXY = 'http://127.0.0.1:7890'
const DEFAULT_SOCKS_PROXY = 'socks5://127.0.0.1:7890'
// Lark / Feishu API hosts are explicitly bypassed because a local proxy
// often can't reach `open.feishu.cn` (the upstream SSL handshake fails),
// which would break the SDK's tenant_access_token refresh (~every 2h).
// `.feishu.cn` / `.larksuite.com` cover the open-platform endpoints.
const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1,10.0.0.0/8,.feishu.cn,.larksuite.com'

const HTTP_PROXY_VARS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy'] as const
const SOCKS_PROXY_VARS = ['ALL_PROXY', 'all_proxy'] as const
const NO_PROXY_VARS = ['NO_PROXY', 'no_proxy'] as const

/** Optional regex (from CLAWX_OVERRIDE_PROXY_PATTERN) matching an
 * inherited proxy value we should force-replace with the default. */
function overridePattern(): RegExp | null {
  const raw = process.env.CLAWX_OVERRIDE_PROXY_PATTERN?.trim()
  if (!raw) return null
  try {
    return new RegExp(raw, 'i')
  } catch {
    return null
  }
}

function shouldOverwrite(current: string | undefined, re: RegExp | null): boolean {
  if (!current) return true
  return re ? re.test(current) : false
}

export function ensureProxyEnv(): void {
  if (process.env.CLAWX_DISABLE_PROXY_INJECT === '1') return

  const httpTarget = (process.env.CLAWX_PROXY_URL ?? DEFAULT_HTTP_PROXY).trim()
  const socksTarget = DEFAULT_SOCKS_PROXY
  const noProxyTarget = (process.env.CLAWX_NO_PROXY ?? DEFAULT_NO_PROXY).trim()
  const re = overridePattern()

  const overrides: Record<string, { before: string; after: string }> = {}

  for (const key of HTTP_PROXY_VARS) {
    const cur = process.env[key]
    if (shouldOverwrite(cur, re)) {
      if (cur && cur !== httpTarget) overrides[key] = { before: cur, after: httpTarget }
      process.env[key] = httpTarget
    }
  }
  for (const key of SOCKS_PROXY_VARS) {
    const cur = process.env[key]
    if (shouldOverwrite(cur, re)) {
      if (cur && cur !== socksTarget) overrides[key] = { before: cur, after: socksTarget }
      process.env[key] = socksTarget
    }
  }
  // For no_proxy we MERGE rather than only-set-when-empty: an outer shell
  // might already have a partial list that would otherwise leave
  // .feishu.cn going through the proxy and failing. Append missing entries.
  const mustHave = noProxyTarget.split(',').map((s) => s.trim()).filter(Boolean)
  for (const key of NO_PROXY_VARS) {
    const cur = (process.env[key] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const merged = Array.from(new Set([...cur, ...mustHave]))
    process.env[key] = merged.join(',')
  }

  if (Object.keys(overrides).length > 0) {
    log.warn('proxy env: overrode inherited proxy values', overrides)
  } else {
    log.debug('proxy env normalized', {
      http: process.env.HTTP_PROXY,
      socks: process.env.ALL_PROXY,
    })
  }
}
