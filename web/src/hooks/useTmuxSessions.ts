import { useCallback, useEffect, useState } from 'react'
import { api, type TmuxSessionEntry, type TmuxCreateBody } from '@/api'

export interface UseTmuxSessionsResult {
  sessions: TmuxSessionEntry[]
  loading: boolean
  error: string | null
  /** Re-fetch the list now (use after a mutation to reflect immediately
   * instead of waiting for the next poll tick). */
  refresh: () => Promise<void>
  /** Create a new tmux session. Returns the new entry on success or an
   * error string. Auto-refreshes the list. */
  create: (body: TmuxCreateBody) => Promise<{ ok: true; entry: TmuxSessionEntry } | { ok: false; error: string }>
  /** Kill a tmux session by sid. Auto-refreshes. */
  kill: (sid: string) => Promise<{ ok: true } | { ok: false; error: string }>
}

/**
 * Polls /api/tmux-sessions every `intervalMs`. Used by the Tmux tab to
 * keep the list fresh without manual refresh. Mutations call the
 * relevant endpoint then refresh immediately so the user sees the new
 * state without a poll wait.
 */
export function useTmuxSessions(intervalMs = 3_000): UseTmuxSessionsResult {
  const [sessions, setSessions] = useState<TmuxSessionEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchOnce = useCallback(async (initial: boolean) => {
    if (initial) setLoading(true)
    try {
      const r = await api.listTmuxSessions()
      setSessions(r.sessions)
      setError(null)
    } catch (err: any) {
      if (initial) setError(err?.message ?? String(err))
    } finally {
      if (initial) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void fetchOnce(true)
    const id = setInterval(() => {
      if (!cancelled) void fetchOnce(false)
    }, intervalMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [fetchOnce, intervalMs])

  const refresh = useCallback(async () => {
    await fetchOnce(false)
  }, [fetchOnce])

  const create = useCallback(
    async (body: TmuxCreateBody) => {
      const r = await api.createTmuxSession(body)
      await refresh()
      if (r.ok && r.entry) return { ok: true as const, entry: r.entry }
      return { ok: false as const, error: r.error ?? 'create failed' }
    },
    [refresh],
  )

  const kill = useCallback(
    async (sid: string) => {
      const r = await api.killTmuxSession(sid)
      await refresh()
      if (r.ok) return { ok: true as const }
      return { ok: false as const, error: r.error ?? 'kill failed' }
    },
    [refresh],
  )

  return { sessions, loading, error, refresh, create, kill }
}
