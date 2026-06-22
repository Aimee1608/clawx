import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

// pm2 is a CJS module; import default and cast to `any` to cross the
// gap between its shipped .d.ts and how we actually call the API. We
// only touch a small surface (connect/start/stop/delete/list/describe),
// and sidestep the type mismatch by calling through `pm2x`.
import pm2Default from 'pm2'
const pm2x = pm2Default as unknown as {
  connect(cb: (err: Error | null) => void): void
  start(opts: Record<string, unknown>, cb: (err: Error | null, procs: Pm2Proc[]) => void): void
  stop(name: string, cb: (err: Error | null) => void): void
  delete(name: string, cb: (err: Error | null) => void): void
  list(cb: (err: Error | null, procs: Pm2Proc[]) => void): void
  describe(name: string, cb: (err: Error | null, procs: Pm2Proc[]) => void): void
  disconnect(): void
}

import type { CliOverrides } from './cli.js'

const PROC_NAME = 'clawx'

interface Pm2Proc {
  name?: string
  pid?: number
  pm_id?: number
  pm2_env?: {
    status?: string
    restart_time?: number
    pm_uptime?: number
    pm_out_log_path?: string
    pm_err_log_path?: string
  }
  monit?: { cpu?: number; memory?: number }
}

function pConnect(): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2x.connect((err) => (err ? reject(err) : resolve()))
  })
}

function pStart(opts: Record<string, unknown>): Promise<Pm2Proc[]> {
  return new Promise((resolve, reject) => {
    pm2x.start(opts, (err, procs) => (err ? reject(err) : resolve(procs)))
  })
}

function pStop(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2x.stop(name, (err) => (err ? reject(err) : resolve()))
  })
}

function pDelete(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    pm2x.delete(name, (err) => (err ? reject(err) : resolve()))
  })
}

function pList(): Promise<Pm2Proc[]> {
  return new Promise((resolve, reject) => {
    pm2x.list((err, procs) => (err ? reject(err) : resolve(procs)))
  })
}

function pDescribe(name: string): Promise<Pm2Proc[]> {
  return new Promise((resolve, reject) => {
    pm2x.describe(name, (err, procs) => (err ? reject(err) : resolve(procs)))
  })
}

function disconnect(): void {
  pm2x.disconnect()
}

function resolveScriptPath(): string {
  // dist/daemon.js (installed) or src/daemon.ts (tsx watch)
  const here = path.dirname(fileURLToPath(import.meta.url))
  // Preferred: sibling cli.js in the same dist/ dir.
  const distCli = path.resolve(here, 'cli.js')
  if (existsSync(distCli)) return distCli
  // Dev fallback: src/cli.ts one dir up, run via tsx.
  const srcCli = path.resolve(here, 'cli.ts')
  if (existsSync(srcCli)) return srcCli
  throw new Error('unable to locate cli.js / cli.ts — rebuild with `pnpm build`.')
}

/** Build the args array pm2 passes to the script. */
function buildStartArgs(overrides: CliOverrides): string[] {
  const args = ['start']
  if (overrides.claudeCwd) args.push('--cwd', overrides.claudeCwd)
  if (overrides.larkAppId) args.push('--lark-app-id', overrides.larkAppId)
  if (overrides.larkAppSecret) args.push('--lark-app-secret', overrides.larkAppSecret)
  return args
}

function cleanPm2Env(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v
  }
  // VS Code / code-server shells can carry a literal `io=undefined`;
  // pm2 interprets any `io` value as JSON and crashes in its fork
  // container before our script starts. Drop invalid pm2-io controls.
  if (env.io && env.io !== 'true' && env.io !== 'false') {
    try {
      JSON.parse(env.io)
    } catch {
      delete env.io
    }
  }
  if (env.pmx === 'undefined') delete env.pmx
  if (env.trace === 'undefined') delete env.trace
  return env
}

export async function daemonStart(opts: { overrides: CliOverrides }): Promise<void> {
  await pConnect()
  try {
    const script = resolveScriptPath()
    const args = buildStartArgs(opts.overrides)

    // If pm2 already has a proc with this name, stop+delete first so
    // start options (env, args) are freshly applied.
    const existing = await pDescribe(PROC_NAME).catch(() => [])
    if (existing.length > 0) {
      await pDelete(PROC_NAME).catch(() => {
        /* ignore */
      })
    }

    const procs = await pStart({
      name: PROC_NAME,
      script,
      args,
      // If script is a .ts file, run it via tsx; otherwise use node directly.
      interpreter: script.endsWith('.ts') ? 'tsx' : 'node',
      // Preserve user's shell env (HTTPS_PROXY et al.) so claude subprocess
      // and the Hub client can reach the internet.
      env: cleanPm2Env(),
      autorestart: true,
      max_restarts: 10,
      // keep logs local to user so `clawx daemon logs` can tail them.
      output: path.join(process.env.HOME ?? '', '.pm2', 'logs', `${PROC_NAME}-out.log`),
      error: path.join(process.env.HOME ?? '', '.pm2', 'logs', `${PROC_NAME}-error.log`),
    })
    const first = procs[0]
    process.stdout.write(
      `✓ clawx daemon started (pid=${first?.pid ?? '?'}, pm_id=${first?.pm_id ?? '?'}).\n` +
        `  Web UI: http://127.0.0.1:8124\n` +
        `  Logs:   clawx daemon logs\n` +
        `  Stop:   clawx daemon stop\n`,
    )
  } finally {
    disconnect()
  }
}

export async function daemonStop(): Promise<void> {
  await pConnect()
  try {
    await pStop(PROC_NAME).catch(() => {
      /* might already be stopped */
    })
    await pDelete(PROC_NAME).catch(() => {
      /* might already be gone */
    })
    process.stdout.write('✓ clawx daemon stopped and removed from pm2.\n')
  } finally {
    disconnect()
  }
}

export async function daemonStatus(): Promise<void> {
  await pConnect()
  try {
    const procs = await pList()
    const ours = procs.filter((p) => p.name === PROC_NAME)
    if (ours.length === 0) {
      process.stdout.write('clawx daemon: not running.\n')
      return
    }
    for (const p of ours) {
      const env = p.pm2_env ?? {}
      const uptimeMs = env.pm_uptime ? Date.now() - env.pm_uptime : 0
      const memMb = p.monit?.memory ? Math.round(p.monit.memory / 1024 / 1024) : 0
      process.stdout.write(
        `clawx daemon: ${env.status ?? 'unknown'} ` +
          `pid=${p.pid ?? '?'} ` +
          `restarts=${env.restart_time ?? 0} ` +
          `uptime=${Math.round(uptimeMs / 1000)}s ` +
          `mem=${memMb}MB\n` +
          `  out: ${env.pm_out_log_path ?? '(?)'}\n` +
          `  err: ${env.pm_err_log_path ?? '(?)'}\n`,
      )
    }
  } finally {
    disconnect()
  }
}

/** Tail daemon logs. Uses pm2.launchBus so it works without a full shell. */
export async function daemonLogs(lines = 100): Promise<void> {
  await pConnect()
  try {
    // Simplest: print current log files (last N lines) then stream new data.
    // pm2.launchBus() streams, but we keep this modest & portable.
    const { spawn } = await import('node:child_process')
    // `pm2 logs clawx --lines=N` is exposed via pm2's own CLI; call it
    // through the programmatically-loaded module path to stay self-contained.
    const pm2Bin = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'node_modules',
      '.bin',
      'pm2',
    )
    const bin = existsSync(pm2Bin) ? pm2Bin : 'pm2'
    const child = spawn(bin, ['logs', PROC_NAME, `--lines=${lines}`], { stdio: 'inherit' })
    await new Promise<void>((resolve) => child.on('exit', () => resolve()))
  } finally {
    disconnect()
  }
}
