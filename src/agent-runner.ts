import { spawn, type ChildProcess } from 'node:child_process'
import { log } from './logger.js'

// Neutral AgentRunner interface: a single in-flight execution against
// some backend (claude CLI today; codex / cursor / a hosted API tomorrow).
//
// Decoupled from the concrete `claude --print` invocation so the worker
// loop in poller.ts doesn't need to change when we swap engines.

export interface AgentRunOptions {
  cwd: string
  sessionId: string
  isNewSession: boolean
  /** **Idle** timeout: kill the process if no stdout/stderr activity has
   * been observed for this many ms — applies ONLY AFTER the first byte
   * has been received. Before that, `firstByteTimeoutMs` applies. The
   * clock resets on every chunk, so a long-running but actively-producing
   * claude task is not killed mid-stream. */
  timeoutMs: number
  /** Time to wait for the FIRST output byte from claude (any stdout /
   * stderr chunk) before giving up. Distinct from idle: cold-start /
   * auth / network handshake / long initial model "thinking" can
   * legitimately produce zero output for several minutes. Default 10
   * min. Override via `CLAUDE_FIRST_BYTE_TIMEOUT_MS` env. Pass 0 to
   * disable (use only idle timeout). */
  firstByteTimeoutMs?: number
  /** Hard ceiling on total runtime regardless of activity. Defends
   * against pathological `claude` processes that keep writing junk
   * forever. Optional — default is 30 minutes; pass 0 to disable. */
  hardTimeoutMs?: number
  /** Extra system-prompt content from WORKFLOW.md. Only honored on new
   * sessions — resumed sessions keep their original prompt. */
  systemPromptSuffix?: string
  /** Restrict the tool-use whitelist. Comma- / space-separated names per
   * `claude --allowed-tools`. When omitted, the CLI default applies. */
  allowedTools?: string[]
  /** Additional directories the agent is allowed to read. Maps to the
   * CLI's `--add-dir`. Useful when phase-runner mounts an external
   * `.claude/` bundle outside the worktree. */
  additionalDirs?: string[]
}

/** Default absolute cap (30 min) when caller doesn't specify hardTimeoutMs.
 * Operators can override via `CLAUDE_HARD_TIMEOUT_MS` env (set to 0 to
 * disable). Read at runtime so changes after process start take effect. */
const FALLBACK_HARD_TIMEOUT_MS = 30 * 60_000

function defaultHardTimeoutMs(): number {
  const raw = process.env.CLAUDE_HARD_TIMEOUT_MS
  if (raw === undefined || raw === '') return FALLBACK_HARD_TIMEOUT_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : FALLBACK_HARD_TIMEOUT_MS
}

/** Default first-byte timeout (30 min — matches hard ceiling).
 *
 * The first-byte tier was originally meant to distinguish "agent hasn't
 * started streaming yet" from "agent was streaming then stalled". That
 * works for streaming callers (`--output-format stream-json`, tmux REPL)
 * which emit init events within a few seconds.
 *
 * But for non-streaming callers (`claude --print --output-format text`
 * used by cron, /scan, /reply, web reply) claude emits ZERO bytes
 * until the entire run completes. There first-byte = wall-clock total.
 * A 10-min default killed legitimately-long memory-refresh crons that
 * scan a whole monorepo. Bumping to 30 min (= hard cap) makes the
 * first-byte tier a no-op for batch callers and a generous safety
 * net for streaming ones.
 *
 * Override via `CLAUDE_FIRST_BYTE_TIMEOUT_MS` env (set to 0 to disable). */
const FALLBACK_FIRST_BYTE_TIMEOUT_MS = 30 * 60_000

function defaultFirstByteTimeoutMs(): number {
  const raw = process.env.CLAUDE_FIRST_BYTE_TIMEOUT_MS
  if (raw === undefined || raw === '') return FALLBACK_FIRST_BYTE_TIMEOUT_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : FALLBACK_FIRST_BYTE_TIMEOUT_MS
}

/** How often to emit a heartbeat log line while a child is running.
 * Lets `tail -f` consumers see "still alive" without spamming. */
const HEARTBEAT_INTERVAL_MS = 30_000

export interface AgentRunner {
  run(prompt: string, opts: AgentRunOptions): Promise<string>
  /** Politely terminate (SIGTERM, then SIGKILL after grace), and wait for
   * the run() promise to settle. Returns once the underlying process is
   * gone or wasn't running. */
  kill(): Promise<void>
  isRunning(): boolean
}

/** Factory pattern keeps the runner stateful (one in-flight subprocess)
 * but lets the worker mint a fresh runner per task without sharing state. */
export type AgentRunnerFactory = () => AgentRunner

/** Default grace period between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 1500

export interface ClaudeRunnerOptions {
  /** Path/name of the claude binary. Defaults to "claude". */
  cmd?: string
  /** Override grace period before escalating to SIGKILL. Test-only knob. */
  killGraceMs?: number
}

export function createClaudeRunner(opts: ClaudeRunnerOptions = {}): AgentRunner {
  const cmd = opts.cmd ?? 'claude'
  const graceMs = opts.killGraceMs ?? KILL_GRACE_MS

  let proc: ChildProcess | null = null
  let exitWaiter: Promise<void> | null = null

  function isRunning(): boolean {
    return proc !== null && !proc.killed && proc.exitCode === null
  }

  async function kill(): Promise<void> {
    const current = proc
    if (!current || current.exitCode !== null) return
    try {
      current.kill('SIGTERM')
    } catch {
      // Already exited between the isRunning check and kill — fine.
      return
    }
    const escalate = setTimeout(() => {
      if (current.exitCode === null) {
        try {
          current.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }
    }, graceMs)
    try {
      if (exitWaiter) await exitWaiter
    } finally {
      clearTimeout(escalate)
    }
  }

  function run(prompt: string, runOpts: AgentRunOptions): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      // CLI session-id flag matrix (preserved from the previous runner):
      //   new session    → --session-id <uuid>
      //   resumed session→ --resume <uuid>
      // Combining the two requires --fork-session, which would *branch* the
      // history rather than continue it.
      const args = [
        '--print',
        '--output-format',
        'text',
        '--permission-mode',
        'bypassPermissions',
      ]
      if (runOpts.isNewSession) {
        args.push('--session-id', runOpts.sessionId)
        if (runOpts.systemPromptSuffix && runOpts.systemPromptSuffix.length > 0) {
          // --append-system-prompt is honored when the session is created.
          // Subsequent --resume calls keep the original system prompt baked
          // in, so we deliberately skip the flag for resumed sessions.
          args.push('--append-system-prompt', runOpts.systemPromptSuffix)
        }
      } else {
        args.push('--resume', runOpts.sessionId)
      }
      if (runOpts.allowedTools && runOpts.allowedTools.length > 0) {
        args.push('--allowed-tools', runOpts.allowedTools.join(','))
      }
      if (runOpts.additionalDirs && runOpts.additionalDirs.length > 0) {
        args.push('--add-dir', ...runOpts.additionalDirs)
      }

      const child = spawn(cmd, args, {
        cwd: runOpts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      })
      proc = child
      const startedAt = Date.now()
      log.debug('claude proc spawned', {
        pid: child.pid,
        sessionId: runOpts.sessionId,
        idleTimeoutMs: runOpts.timeoutMs,
        hardTimeoutMs: runOpts.hardTimeoutMs ?? defaultHardTimeoutMs(),
      })

      let stdout = ''
      let stderr = ''
      let lastActivityAt = Date.now()
      let totalBytes = 0
      const onActivity = (chunk: Buffer): void => {
        lastActivityAt = Date.now()
        totalBytes += chunk.length
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        onActivity(chunk)
        stdout += chunk.toString()
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        onActivity(chunk)
        stderr += chunk.toString()
      })

      // Two-tier silence watchdog:
      //   - While `totalBytes === 0`: use firstByteTimeoutMs. Covers
      //     cold-start, auth handshake, network setup, and the model's
      //     initial "thinking" before any token streams out.
      //   - After the first byte arrives: switch to idle timeout. Once a
      //     stream is flowing, going silent for `timeoutMs` means the
      //     agent is stuck — that's the original idle semantics.
      // Pass `firstByteTimeoutMs: 0` to disable the first-byte tier
      // entirely (forces a single idle clock from spawn).
      let timeoutReason: 'first-byte' | 'idle' | 'hard' | null = null
      const firstByteMs = runOpts.firstByteTimeoutMs ?? defaultFirstByteTimeoutMs()
      const idleCheckInterval = Math.min(5_000, Math.max(1_000, Math.floor(runOpts.timeoutMs / 4)))
      const idleTimer = setInterval(() => {
        if (child.exitCode !== null) return
        const silentMs = Date.now() - lastActivityAt
        if (totalBytes === 0 && firstByteMs > 0) {
          if (silentMs >= firstByteMs) {
            timeoutReason = 'first-byte'
            log.warn('claude first-byte-timeout — killing', {
              pid: child.pid,
              waitedMs: silentMs,
              firstByteMs,
              sessionId: runOpts.sessionId,
            })
            try {
              child.kill('SIGKILL')
            } catch {
              /* ignore */
            }
          }
          return
        }
        if (silentMs >= runOpts.timeoutMs) {
          timeoutReason = 'idle'
          log.warn('claude idle-timeout — killing', {
            pid: child.pid,
            idleMs: silentMs,
            totalBytes,
            sessionId: runOpts.sessionId,
          })
          try {
            child.kill('SIGKILL')
          } catch {
            /* ignore */
          }
        }
      }, idleCheckInterval)

      // Hard ceiling — never lets a runaway / progress-spamming claude
      // pin a CPU forever. Set to 0 to disable.
      const hardCapMs = runOpts.hardTimeoutMs ?? defaultHardTimeoutMs()
      const hardTimer = hardCapMs > 0
        ? setTimeout(() => {
            if (child.exitCode !== null) return
            timeoutReason = 'hard'
            log.warn('claude hard-timeout — killing', {
              pid: child.pid,
              elapsedMs: Date.now() - startedAt,
              totalBytes,
              sessionId: runOpts.sessionId,
            })
            try {
              child.kill('SIGKILL')
            } catch {
              /* ignore */
            }
          }, hardCapMs)
        : null

      // Heartbeat: visibility for `tail -f /tmp/clawbot-hub.log`. Quiet
      // during idle so we don't drown out other logs.
      const heartbeat = setInterval(() => {
        if (child.exitCode !== null) return
        log.debug('claude proc heartbeat', {
          pid: child.pid,
          totalBytes,
          idleSecs: Math.round((Date.now() - lastActivityAt) / 1000),
          elapsedSecs: Math.round((Date.now() - startedAt) / 1000),
        })
      }, HEARTBEAT_INTERVAL_MS)

      let resolved = false
      const settle = (fn: () => void) => {
        if (resolved) return
        resolved = true
        clearInterval(idleTimer)
        if (hardTimer) clearTimeout(hardTimer)
        clearInterval(heartbeat)
        proc = null
        exitWaiter = null
        fn()
      }

      exitWaiter = new Promise<void>((res) => {
        child.once('exit', () => res())
        child.once('error', () => res())
      })

      child.on('error', (err) => {
        settle(() => reject(new Error(`claude spawn error: ${err.message}`)))
      })

      child.on('exit', (code, signal) => {
        if (signal === 'SIGKILL' || signal === 'SIGTERM') {
          // Distinguish watchdog-initiated kills from external kill -9.
          if (timeoutReason === 'first-byte') {
            settle(() =>
              reject(
                new Error(
                  `claude first-byte timeout: no output received in ${firstByteMs}ms ` +
                    `(elapsed ${Date.now() - startedAt}ms, 0 bytes). Likely cold-start / ` +
                    `auth / network. Raise CLAUDE_FIRST_BYTE_TIMEOUT_MS to tolerate longer waits.`,
                ),
              ),
            )
            return
          }
          if (timeoutReason === 'idle') {
            settle(() =>
              reject(
                new Error(
                  `claude idle timeout: no output for ${runOpts.timeoutMs}ms ` +
                    `(${totalBytes} bytes received in ${Date.now() - startedAt}ms before silence)`,
                ),
              ),
            )
            return
          }
          if (timeoutReason === 'hard') {
            settle(() =>
              reject(
                new Error(
                  `claude hard timeout: exceeded ${hardCapMs}ms total runtime ` +
                    `(${totalBytes} bytes received)`,
                ),
              ),
            )
            return
          }
          settle(() => reject(new Error('claude process killed')))
          return
        }
        if (code === 0) {
          const out = stdout.trim()
          settle(() => resolve(out))
          return
        }
        // Claude CLI prints some failures (notably auth/network errors) to
        // stdout, not stderr. Include both in the error so the operator
        // sees the real cause without having to dig into the session jsonl.
        const parts = [`claude exit code=${code}`]
        if (stderr) parts.push(`stderr: ${stderr.slice(0, 400)}`)
        if (stdout) parts.push(`stdout: ${stdout.slice(0, 400)}`)
        const msg = parts.join(', ')
        settle(() => reject(new Error(msg)))
      })

      try {
        child.stdin?.write(prompt)
        child.stdin?.end()
      } catch (err) {
        settle(() => reject(err instanceof Error ? err : new Error(String(err))))
      }
    })
  }

  return { run, kill, isRunning }
}

/** Convenience factory wired with a fixed claude command. */
export function claudeAgentRunnerFactory(claudeCmd: string): AgentRunnerFactory {
  return () => createClaudeRunner({ cmd: claudeCmd })
}
