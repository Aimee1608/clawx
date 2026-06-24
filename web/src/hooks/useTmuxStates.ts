import { useEffect, useState } from 'react'

import { api, type TmuxSessionState } from '@/api'

/**
 * Polls /api/tmux-sessions/states and exposes the result keyed by sessionId
 * so the dashboard cards can render a live status badge. Slower default than
 * the session list (6s) because each tick captures every pane on the backend
 * — the expensive part — whereas the list is a cheap in-memory read.
 *
 * Errors are swallowed (the badge just shows the last known / unknown state);
 * a transient capture failure must never blank the whole board.
 */
export function useTmuxStates(intervalMs = 6_000): Map<string, TmuxSessionState> {
  const [states, setStates] = useState<Map<string, TmuxSessionState>>(() => new Map())

  useEffect(() => {
    let cancelled = false
    const tick = async (): Promise<void> => {
      try {
        const r = await api.tmuxSessionStates()
        if (cancelled) return
        setStates(new Map(r.states.map((s) => [s.sessionId, s])))
      } catch {
        /* keep last known states */
      }
    }
    void tick()
    const id = setInterval(() => void tick(), intervalMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [intervalMs])

  return states
}
