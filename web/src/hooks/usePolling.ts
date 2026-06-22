import { useEffect, useRef, useState } from 'react'

/**
 * Generic polling hook: runs `fetcher` on mount + at `intervalMs` cadence.
 * Owns the `data` / `loading` / `error` states. Background-poll failures
 * are silent — only the first call surfaces an error to keep the UI from
 * flashing on transient network blips.
 *
 * Cleanup is guaranteed: in-flight promises see `cancelled=true` after
 * unmount, and the interval is cleared.
 */
export interface UsePollingOptions<T> {
  fetcher: () => Promise<T>
  /** Polling cadence in ms. Set to `null` or `0` to disable polling (still does first fetch). */
  intervalMs: number | null
  /** Optional dependency list — when these change, the hook re-arms. */
  deps?: React.DependencyList
  /** If true, skip the very first fetch. Useful when target isn't ready yet. */
  paused?: boolean
}

export interface UsePollingResult<T> {
  data: T | null
  loading: boolean
  error: string | null
  /** Fire an extra fetch immediately, e.g. after a mutation. */
  refresh: () => Promise<void>
}

export function usePolling<T>({
  fetcher,
  intervalMs,
  deps = [],
  paused = false,
}: UsePollingOptions<T>): UsePollingResult<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Stash `fetcher` in a ref so we don't restart the interval each render
  // when the caller passes an inline arrow function.
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const cancelledRef = useRef(false)

  async function runOnce(initial: boolean): Promise<void> {
    if (initial) setLoading(true)
    try {
      const r = await fetcherRef.current()
      if (cancelledRef.current) return
      setData(r)
      setError(null)
    } catch (err: any) {
      if (cancelledRef.current) return
      // Only surface error from the initial fetch — subsequent background
      // poll failures are likely transient and we don't want to flash.
      if (initial) setError(err?.message ?? String(err))
    } finally {
      if (!cancelledRef.current && initial) setLoading(false)
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (paused) return
    cancelledRef.current = false
    void runOnce(true)
    if (!intervalMs) return
    const id = setInterval(() => {
      if (!cancelledRef.current) void runOnce(false)
    }, intervalMs)
    return () => {
      cancelledRef.current = true
      clearInterval(id)
    }
  }, [intervalMs, paused, ...deps])

  return {
    data,
    loading,
    error,
    refresh: () => runOnce(false),
  }
}
