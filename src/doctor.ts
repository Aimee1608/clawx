import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import type { CliOverrides } from './cli.js'
import { configDir } from './config.js'

interface Check {
  name: string
  status: 'ok' | 'warn' | 'fail'
  detail: string
}

function userConfigPath(): string {
  return path.join(configDir(), 'config.json')
}

function checkClaudeCli(): Check {
  const res = spawnSync('claude', ['--version'], { encoding: 'utf8' })
  if (res.error) {
    return {
      name: 'claude CLI',
      status: 'fail',
      detail: `not found or not executable: ${res.error.message}. Install with: npm i -g @anthropic-ai/claude-code`,
    }
  }
  if (res.status !== 0) {
    return {
      name: 'claude CLI',
      status: 'fail',
      detail: `exit ${res.status}: ${(res.stderr || '').trim() || '(no stderr)'}`,
    }
  }
  return { name: 'claude CLI', status: 'ok', detail: (res.stdout || '').trim() }
}

function checkOauthToken(): Check {
  const tok = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim()
  if (tok && tok.length > 0) {
    return {
      name: 'OAUTH_TOKEN',
      status: 'ok',
      detail: `CLAUDE_CODE_OAUTH_TOKEN set (${tok.length} chars). Used by web chat SDK.`,
    }
  }
  if (apiKey && apiKey.length > 0) {
    return {
      name: 'OAUTH_TOKEN',
      status: 'warn',
      detail:
        'CLAUDE_CODE_OAUTH_TOKEN unset; ANTHROPIC_API_KEY is set as fallback. Web chat will work but bills against API key — for OAuth-based subscription pricing run `claude setup-token`.',
    }
  }
  return {
    name: 'OAUTH_TOKEN',
    status: 'warn',
    detail:
      'Neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY set. Web chat will fail with "401 unauthenticated" on first send. Run `claude setup-token` then export CLAUDE_CODE_OAUTH_TOKEN=...',
  }
}

function checkProxy(): Check {
  const has = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].filter((k) => process.env[k])
  if (has.length === 0) {
    return {
      name: 'proxy env',
      status: 'warn',
      detail:
        'No HTTPS_PROXY/HTTP_PROXY set. If this box needs a proxy to reach api.anthropic.com ' +
        '(common with some corporate proxies), claude will fail with 403 "Request not allowed".',
    }
  }
  return { name: 'proxy env', status: 'ok', detail: has.join('=') + ' set' }
}

function checkUserConfig(): Check {
  const p = userConfigPath()
  if (!fs.existsSync(p)) {
    return { name: 'user config file', status: 'warn', detail: `not present (${p})` }
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
    const keys = Object.keys(parsed)
    return { name: 'user config file', status: 'ok', detail: `${p} (${keys.length} keys: ${keys.join(', ')})` }
  } catch (err: any) {
    return { name: 'user config file', status: 'fail', detail: `${p} parse error: ${err?.message}` }
  }
}

export async function runDoctor(_overrides: CliOverrides = {}): Promise<void> {
  const checks: Check[] = [checkClaudeCli(), checkOauthToken(), checkProxy(), checkUserConfig()]

  const mark = { ok: '✓', warn: '!', fail: '✗' }
  let failed = 0
  for (const c of checks) {
    process.stdout.write(`  ${mark[c.status]} ${c.name.padEnd(22)} ${c.detail}\n`)
    if (c.status === 'fail') failed++
  }
  process.stdout.write('\n')
  if (failed > 0) {
    process.stderr.write(`${failed} check(s) failed.\n`)
    process.exit(1)
  }
}
