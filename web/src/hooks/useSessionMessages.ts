import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { UiMessage } from '@/api'

export interface MessageFetcher {
  uuid: string
  /** Caller plugs in the right backend (bot vs all-claude). */
  fetch: (uuid: string) => Promise<{
    messages: UiMessage[]
    path: string
    note?: string
    lastModifiedMs?: number
    nowMs?: number
  }>
}

export interface UseSessionMessagesResult {
  messages: UiMessage[]
  loading: boolean
  error: string | null
  note: string | null
  /** Jsonl mtime + server time, when the backend returns them. The
   * composer uses these to flag "session may still be running". */
  lastModifiedMs: number | null
  nowMs: number | null
  /** Manual refresh — call after sending a reply so the new turn shows
   * up immediately instead of waiting for the next poll tick. */
  refresh: () => Promise<void>
  /** Show a user message immediately in the drawer, before the jsonl
   * has caught up. Used by the tmux composer: after POSTing send-keys
   * the user's text won't appear in the jsonl for a second or two, so
   * we render it optimistically. Auto-clears once a fetched message
   * with the same text is observed, or after a 30s safety expiry. */
  addOptimisticUserMessage: (text: string) => void
}

interface Optimistic {
  text: string
  addedAt: number
  uuid: string
}

const OPTIMISTIC_TTL_MS = 30_000

/**
 * Polls a session's messages while a target is set; cleans up on close
 * or target switch.
 */
export function useSessionMessages(
  target: MessageFetcher | null,
  intervalMs = 3000,
): UseSessionMessagesResult {
  const [fetched, setFetched] = useState<UiMessage[]>([])
  const [optimistic, setOptimistic] = useState<Optimistic[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [lastModifiedMs, setLastModifiedMs] = useState<number | null>(null)
  const [nowMs, setNowMs] = useState<number | null>(null)
  const targetRef = useRef(target)
  targetRef.current = target

  const fetchOnce = useCallback(
    async (initial: boolean): Promise<void> => {
      const t = targetRef.current
      if (!t) return
      if (initial) setLoading(true)
      try {
        const r = await t.fetch(t.uuid)
        // Guard against target switch during the in-flight fetch.
        if (targetRef.current !== t) return
        setFetched(r.messages)
        setNote(r.note ?? null)
        setLastModifiedMs(typeof r.lastModifiedMs === 'number' ? r.lastModifiedMs : null)
        setNowMs(typeof r.nowMs === 'number' ? r.nowMs : null)
        setError(null)
        // Reconcile optimistic: drop entries whose text was seen in the
        // fetched user messages OR whose TTL expired.
        setOptimistic((prev) => {
          if (prev.length === 0) return prev
          const now = Date.now()
          const fetchedUserTexts = new Set(
            r.messages.filter((m) => m.role === 'user').map((m) => m.text),
          )
          return prev.filter(
            (o) =>
              !fetchedUserTexts.has(o.text) && now - o.addedAt < OPTIMISTIC_TTL_MS,
          )
        })
      } catch (err: any) {
        if (targetRef.current !== t) return
        if (initial) setError(err?.message ?? String(err))
      } finally {
        if (targetRef.current === t && initial) setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    if (!target) {
      setFetched([])
      setOptimistic([])
      setError(null)
      setNote(null)
      setLastModifiedMs(null)
      setNowMs(null)
      return
    }
    void fetchOnce(true)
    const id = setInterval(() => {
      void fetchOnce(false)
    }, intervalMs)

    return () => {
      clearInterval(id)
    }
  }, [target, intervalMs, fetchOnce])

  const refresh = useCallback(async () => {
    await fetchOnce(false)
  }, [fetchOnce])

  const addOptimisticUserMessage = useCallback((text: string) => {
    if (!text.trim()) return
    setOptimistic((prev) => [
      ...prev,
      {
        text,
        addedAt: Date.now(),
        uuid: `optimistic-${Math.random().toString(36).slice(2, 10)}`,
      },
    ])
  }, [])

  // Merge optimistic at the END (most recent). Drawer renders them as
  // a normal user bubble with a synthetic uuid so React keys are stable.
  const messages = useMemo<UiMessage[]>(() => {
    if (optimistic.length === 0) return fetched
    const synth: UiMessage[] = optimistic.map((o) => ({
      role: 'user',
      text: o.text,
      timestamp: new Date(o.addedAt).toISOString(),
      uuid: o.uuid,
    }))
    return [...fetched, ...synth]
  }, [fetched, optimistic])

  return {
    messages,
    loading,
    error,
    note,
    lastModifiedMs,
    nowMs,
    refresh,
    addOptimisticUserMessage,
  }
}
