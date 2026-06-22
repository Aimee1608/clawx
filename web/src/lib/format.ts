// Shared display formatters. Keep stateless / no React imports so they can
// be used by hooks, components, and stories alike.

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/**
 * Local wall-clock formatter producing `YYYY-MM-DD HH:MM:SS`. We use the
 * `sv-SE` locale because it conveniently emits ISO-like layout without
 * the `T` separator, which reads cleaner than `toLocaleString()` defaults
 * across user locales.
 */
export function formatLocalTime(ms: number): string {
  const d = new Date(ms)
  const date = d.toLocaleDateString('sv-SE')
  const time = d.toLocaleTimeString('sv-SE', { hour12: false })
  return `${date} ${time}`
}

export function relativeTime(ms: number): string {
  const diff = (Date.now() - ms) / 1000
  if (diff < 5) return 'just now'
  if (diff < 60) return `${Math.round(diff)}s ago`
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`
  return `${Math.round(diff / 86400)}d ago`
}

export function relSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Take last two segments of a path: `/a/b/c/d` → `c/d`. Used to render
 * compact PWD labels in tables. */
export function lastTwoSegs(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts.slice(-2).join('/')
}

/** Pull the email tail out of a Hub-mode sessionId like `<chatId>:<email>`.
 * Returns null in WS mode or any case where the last segment isn't email-shaped. */
export function emailFromSessionId(sessionId: string): string | null {
  const tail = sessionId.split(':').slice(-1)[0] ?? ''
  return tail.includes('@') ? tail : null
}
