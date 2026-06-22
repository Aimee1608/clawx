import { useEffect, useRef, useState } from 'react'
import { api } from '@/api'

export interface RawPaneViewerProps {
  /** clawx session id (NOT tmux name) — backed by /api/tmux-sessions/:sid/capture. */
  sid: string
  /** Poll interval in ms. Default 1500ms — fast enough to feel "live"
   * without melting tmux with capture-pane on every tick. */
  intervalMs?: number
}

/**
 * Polls capture-pane and renders the raw terminal text as <pre>.
 * We strip the most common ANSI escape sequences so colors / cursor
 * movement don't show as gibberish; the result still looks like a
 * terminal snapshot (the user's main goal here is "see what claude is
 * doing right now", not "render TUI perfectly"). For the latter we'd
 * need xterm.js — left as a future option.
 *
 * Bottom-pinned auto-scroll so new output is always visible.
 */
export function RawPaneViewer({ sid, intervalMs = 1500 }: RawPaneViewerProps): JSX.Element {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLPreElement | null>(null)
  const atBottomRef = useRef(true)

  useEffect(() => {
    let cancelled = false
    async function tick(): Promise<void> {
      try {
        const r = await api.captureTmuxSession(sid)
        if (cancelled) return
        if (r.ok && typeof r.text === 'string') {
          setText(stripAnsi(r.text))
          setError(null)
        } else if (!r.ok) {
          setError(r.error ?? 'capture failed')
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? String(err))
      }
    }
    void tick()
    const id = setInterval(tick, intervalMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [sid, intervalMs])

  // Auto-scroll only when the user is already near the bottom; respect
  // a manual scroll-up so they can read past output.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !atBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [text])

  function onScroll(e: React.UIEvent<HTMLPreElement>): void {
    const el = e.currentTarget
    atBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8
  }

  return (
    <div className="relative h-full">
      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      ) : (
        <pre
          ref={scrollRef}
          onScroll={onScroll}
          className="h-full overflow-auto whitespace-pre-wrap bg-zinc-950 px-3 py-2 font-mono text-xs leading-snug text-zinc-100"
        >
          {text || '(waiting for output…)'}
        </pre>
      )}
    </div>
  )
}

/**
 * Strip the most common ANSI escape sequences. Doesn't try to render
 * color into HTML — for that we'd need a proper VT parser. The goal is
 * just to make capture-pane output readable.
 */
function stripAnsi(s: string): string {
  // CSI sequences: ESC [ ... letter (covers color, cursor, ED/EL)
  // and the simpler ESC ( B / ESC ] ... BEL forms.
  return s
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, '')
    .replace(/\x1B[@-Z\\-_]/g, '')
}
