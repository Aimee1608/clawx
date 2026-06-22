import { createClaudeRunner, type AgentRunOptions } from './agent-runner.js'

// Backwards-compatible shim around `agent-runner.ts`. Pre-existing call
// sites (mcp-server, manager-commands, cron-engine) keep using
// `createClaudeHandle()` with synchronous `kill()`. The poller / ws-worker
// path moved to AgentRunner directly to access SystemPromptSuffix and the
// awaitable kill semantics.

export interface RunOptions {
  cmd: string
  cwd: string
  sessionId: string
  isNewSession: boolean
  /** Idle timeout (resets on each stdout/stderr chunk); only kicks in
   * after the first byte arrives. See AgentRunOptions for the rationale
   * behind the two-tier design. */
  timeoutMs: number
  /** Optional first-byte timeout. Defaults to agent-runner's 10-minute
   * ceiling (override via CLAUDE_FIRST_BYTE_TIMEOUT_MS). Pass 0 to
   * disable the first-byte tier entirely. */
  firstByteTimeoutMs?: number
  /** Optional wall-clock cap. Forwarded to agent-runner; defaults to its
   * 30-minute ceiling when omitted. Pass 0 to disable. */
  hardTimeoutMs?: number
}

export interface ClaudeHandle {
  run(prompt: string, opts: RunOptions): Promise<string>
  kill(): void
  isRunning(): boolean
}

export function createClaudeHandle(): ClaudeHandle {
  // Each call creates a fresh inner runner so callers retain the
  // "one in-flight per handle" semantics they already rely on. The cmd
  // is rebound per `run()` because the legacy interface accepts cmd as a
  // run option, not a constructor option.
  let inner = createClaudeRunner()

  return {
    isRunning: () => inner.isRunning(),
    kill: () => {
      // Fire-and-forget: legacy callers expect sync void return.
      void inner.kill()
    },
    run: (prompt, opts) => {
      inner = createClaudeRunner({ cmd: opts.cmd })
      const runOpts: AgentRunOptions = {
        cwd: opts.cwd,
        sessionId: opts.sessionId,
        isNewSession: opts.isNewSession,
        timeoutMs: opts.timeoutMs,
        ...(opts.firstByteTimeoutMs !== undefined ? { firstByteTimeoutMs: opts.firstByteTimeoutMs } : {}),
        ...(opts.hardTimeoutMs !== undefined ? { hardTimeoutMs: opts.hardTimeoutMs } : {}),
      }
      return inner.run(prompt, runOpts)
    },
  }
}
