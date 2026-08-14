/**
 * Parsing for the Lark control words that must be recognized in BOTH the
 * DM dispatch chain and inside a session thread. Kept out of ws-main so
 * the matching rules are unit-testable without booting the WS client.
 */

/** `/new-solo [别名] [label]` and its aliases. In a thread the `-tmux`
 * form is included too (the DM chain has its own `/new-tmux` branch that
 * runs first). Interception in threads is mandatory: claude registers
 * `new` as an alias of `/clear`, so a raw send-keys would wipe the
 * session's context instead of building a new session. */
const NEW_SOLO_DM = /^\/new(?:-solo)?(?:\s+(.+))?$/i
const NEW_SOLO_THREAD = /^\/new(?:-solo|-tmux)?(?:\s+(.+))?$/i

export type NewSoloCommand = {
  /** Everything after the command word, trimmed. Empty → list aliases. */
  rest: string
}

/**
 * Returns the parsed command, or null when the text isn't one. Only a
 * whole-message match counts, so a sentence merely mentioning `/new`
 * stays an ordinary prompt.
 */
export function parseNewSoloCommand(
  text: string,
  opts: { inThread: boolean },
): NewSoloCommand | null {
  const m = text.trim().match(opts.inThread ? NEW_SOLO_THREAD : NEW_SOLO_DM)
  if (!m) return null
  return { rest: m[1]?.trim() ?? '' }
}
