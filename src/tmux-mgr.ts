import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Thin shell wrapper over `tmux`. All methods spawn the binary fresh —
 * tmux itself is the persistence layer (sessions survive across clawx
 * restarts). Failures bubble as Error(stderr) so callers can choose
 * between "session gone" (kill, has-session) vs hard errors.
 *
 * Names: callers MUST pass an already-safe identifier (the clawx
 * session id with `:` replaced and similar). We do a final defensive
 * check here but the caller owns the namespace.
 */

const TMUX_NAME_SAFE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

function assertSafeName(name: string): void {
  if (!TMUX_NAME_SAFE.test(name)) {
    throw new Error(`unsafe tmux session name: ${JSON.stringify(name)}`)
  }
}

export interface TmuxMgr {
  /** Whether a session with this name currently exists. */
  hasSession(name: string): Promise<boolean>
  /**
   * Create a new detached tmux session. `cmd` is the shell command to
   * launch inside the first window. Uses `-x 200 -y 50` so capture-pane
   * yields useful wrapping behavior even when no terminal is attached.
   * Returns when tmux has the session listed; does NOT wait for `cmd`
   * to be ready (the spawned process is independent).
   *
   * `env` injects key=value pairs into the new session via `tmux -e`.
   * Use this to OVERRIDE values inherited from the tmux server's env
   * (the server was likely started by an interactive shell that may
   * have shell-local proxy or PATH values we don't want to leak into
   * the claude REPL).
   */
  newSession(opts: {
    name: string
    cwd: string
    cmd: string
    env?: Record<string, string>
  }): Promise<void>
  /**
   * Type `text` into the session's active pane, optionally followed by
   * Enter. `text` can contain newlines — tmux's `send-keys` accepts them
   * literally. Caller is responsible for serializing sends per-session
   * (tmux itself doesn't lock).
   */
  sendKeys(opts: { name: string; text: string; pressEnter?: boolean }): Promise<void>
  /** Send a single NAMED tmux key (e.g. 'Escape', 'C-c') to the active
   * pane — interpreted as a key name, NOT literal text. For control keys
   * like Escape (interrupt the REPL). Caller passes a fixed key name,
   * never raw user input. */
  sendKey(opts: { name: string; key: string }): Promise<void>
  /**
   * Capture the visible pane plus scrollback (up to `lines`). Useful for
   * debug + initial state hydration in the web UI.
   */
  capturePane(opts: { name: string; lines?: number }): Promise<string>
  /** Terminate a session and all its panes. Safe to call on missing names. */
  killSession(name: string): Promise<void>
  /** List currently-living tmux session names. */
  listSessions(): Promise<string[]>
  /** Set a per-session tmux option (`set-option -t <name> -q ...`). Used
   * to override status-left so the bottom bar shows a human-readable
   * title instead of the slugified session id. Idempotent. */
  setSessionOption(opts: { name: string; option: string; value: string }): Promise<void>
  /** Rename the first window of a session. Combined with `set-titles
   * on` + `set-titles-string '#W'` this propagates to the terminal
   * emulator's tab title so the operator can distinguish many open
   * `tmux attach -t ...` terminals at a glance. */
  renameWindow(opts: { name: string; index?: number; title: string }): Promise<void>
}

export interface TmuxMgrOptions {
  /** Path to the tmux binary. Defaults to `tmux` (PATH lookup). */
  tmuxCmd?: string
}

export function createTmuxMgr(opts: TmuxMgrOptions = {}): TmuxMgr {
  const tmux = opts.tmuxCmd ?? 'tmux'

  async function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execFileAsync(tmux, args, {
        maxBuffer: 4 * 1024 * 1024,
      })
    } catch (err: any) {
      // execFile rejects with err.stdout/err.stderr — surface them so the
      // caller's catch sees the real tmux complaint.
      const stderr = (err.stderr ?? '').toString().trim()
      const stdout = (err.stdout ?? '').toString().trim()
      throw new Error(
        `tmux ${args[0]} failed: ${stderr || stdout || err.message}`,
      )
    }
  }

  /** Leave copy-mode/view-mode if the pane is in one, so a following
   * send-keys types into the REPL instead of being swallowed as a
   * copy-mode key binding. This is the fix for a silent message-loss
   * bug: when the operator has the session attached and scrolls the
   * history (Ctrl-b [ or the mouse wheel), the pane enters copy-mode;
   * every send-keys the daemon issues then gets eaten as a copy-mode
   * command and never reaches claude — a Feishu message vanishes with
   * no trace. `-X cancel` exits the mode; it's a cheap no-op when the
   * pane isn't in a mode. */
  async function exitCopyMode(name: string): Promise<void> {
    try {
      const { stdout } = await run(['display-message', '-p', '-t', name, '#{pane_in_mode}'])
      if (stdout.trim() === '1') {
        await run(['send-keys', '-t', name, '-X', 'cancel'])
      }
    } catch {
      /* best-effort — if we can't tell, fall through and send anyway */
    }
  }

  return {
    async hasSession(name) {
      assertSafeName(name)
      try {
        await execFileAsync(tmux, ['has-session', '-t', name])
        return true
      } catch {
        return false
      }
    },

    async newSession({ name, cwd, cmd, env }) {
      assertSafeName(name)
      // -d detach immediately; -x/-y so capture-pane has a sane geometry
      // even without an attached client.
      // -e KEY=VAL injects env vars into the new session, overriding any
      // value inherited from the tmux server's env. Critical for proxy:
      // the tmux server typically inherits an interactive shell's env
      // (which on this host carries the corporate proxy) so without
      // explicit overrides, the claude REPL would route through the
      // wrong proxy regardless of what the daemon's own env says.
      const envArgs: string[] = []
      if (env) {
        for (const [k, v] of Object.entries(env)) {
          envArgs.push('-e', `${k}=${v}`)
        }
      }
      await run([
        'new-session',
        '-d',
        '-s',
        name,
        '-c',
        cwd,
        '-x',
        '200',
        '-y',
        '50',
        ...envArgs,
        cmd,
      ])
    },

    async sendKeys({ name, text, pressEnter }) {
      assertSafeName(name)
      // Bail the pane out of copy-mode first, else the text below is
      // swallowed as copy-mode keys and the message is lost silently.
      await exitCopyMode(name)
      // Split text and Enter into TWO send-keys invocations:
      //   1. `-l` (literal) so tmux types the text as-is without
      //      interpreting embedded newlines as Enter or backslash
      //      sequences as escapes. Critical for multi-line composer
      //      input and for non-ASCII text where a stray `\n` would
      //      submit early.
      //   2. A second call sends Enter as a key event.
      // Doing this in one call (`send-keys -t name "text" Enter`)
      // historically worked but raced with claude REPL's multi-byte
      // input buffering — chars would land in the input box but the
      // Enter would arrive while the REPL was mid-redraw, silently
      // dropped.
      if (text.length > 0) {
        // `--` ends tmux's option parsing so text starting with `-`
        // (e.g. a code snippet pasted from Lark like `-c file.ts` or
        // a flag-style command argument) doesn't get parsed as a
        // tmux flag → "command send-keys: invalid flag -c".
        await run(['send-keys', '-t', name, '-l', '--', text])
      }
      if (pressEnter) {
        await run(['send-keys', '-t', name, 'Enter'])
      }
    },

    async sendKey({ name, key }) {
      assertSafeName(name)
      // Exit copy-mode first: otherwise Escape/C-c just leaves copy-mode
      // instead of reaching the REPL, so an `esc` interrupt would no-op
      // when the operator happens to be scrolling the pane.
      await exitCopyMode(name)
      // No `-l`: tmux interprets `key` as a key NAME (Escape, C-c, …),
      // not literal characters.
      await run(['send-keys', '-t', name, key])
    },

    async capturePane({ name, lines = 500 }) {
      assertSafeName(name)
      // -p print to stdout, -S -N for scrollback start, -J for join wrap
      const { stdout } = await run([
        'capture-pane',
        '-t',
        name,
        '-p',
        '-J',
        '-S',
        String(-Math.abs(lines)),
      ])
      return stdout
    },

    async killSession(name) {
      assertSafeName(name)
      // Don't error on missing — make this idempotent.
      try {
        await execFileAsync(tmux, ['kill-session', '-t', name])
      } catch {
        /* session may already be gone */
      }
    },

    async listSessions() {
      try {
        const { stdout } = await execFileAsync(tmux, [
          'list-sessions',
          '-F',
          '#{session_name}',
        ])
        return stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
      } catch (err: any) {
        const stderr = (err.stderr ?? '').toString()
        // "no server running" is normal when no sessions exist.
        if (stderr.includes('no server running')) return []
        throw err
      }
    },

    async setSessionOption({ name, option, value }) {
      assertSafeName(name)
      // -q (quiet) so tmux doesn't error when option is unknown / not
      // settable at session level — best effort. Value is passed as a
      // single argv element to execFileAsync, so embedded special
      // characters need no extra escaping (no shell involved).
      await run(['set-option', '-t', name, '-q', option, value])
    },

    async renameWindow({ name, index, title }) {
      assertSafeName(name)
      // Target `<session>:` (no index) → tmux applies to the ACTIVE
      // window. Safer than hard-coding `:0` because users with
      // `base-index 1` in their tmux.conf don't have a window 0 and
      // the rename would error out with `can't find window: 0`.
      const target = typeof index === 'number' ? `${name}:${index}` : name
      await run(['rename-window', '-t', target, title])
    },
  }
}
