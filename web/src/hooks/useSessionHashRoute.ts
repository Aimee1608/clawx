import { useEffect, useState } from 'react'

/**
 * Synchronize the message-detail drawer with `window.location.hash`.
 *
 * URL convention:
 *   `#/session/<uuid>` opens the messages drawer for that uuid.
 *   no hash (or anything else) closes it.
 *
 * Why hash routing rather than path routing:
 *   - The dashboard is served as a single SPA from clawx's embedded
 *     HTTP server. Path routing would require server-side fallback to
 *     index.html for unknown paths; hash routing is purely client-side
 *     and Just Works.
 *   - Allows deep-linking (paste URL in another tab, refresh keeps you
 *     in the same view) and natural browser back/forward navigation.
 */

const SESSION_HASH_RE = /^#\/session\/([a-f0-9-]{36})$/i

function parseHash(): string | null {
  if (typeof window === 'undefined') return null
  const m = SESSION_HASH_RE.exec(window.location.hash)
  return m ? m[1]! : null
}

export interface SessionHashRoute {
  /** UUID parsed from `#/session/<uuid>`, or null if no session is in the URL. */
  uuid: string | null
  /** Push `#/session/<uuid>` to the URL. Creates a history entry so the
   * browser back button restores the previous (no-drawer) state. */
  open: (uuid: string) => void
  /** Clear the session hash. Uses `replaceState` (no history entry) so
   * pressing back doesn't reopen the drawer. */
  close: () => void
}

export function useSessionHashRoute(): SessionHashRoute {
  const [uuid, setUuid] = useState<string | null>(parseHash())

  useEffect(() => {
    function onHashChange(): void {
      setUuid(parseHash())
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  return {
    uuid,
    open: (next: string) => {
      // Setting `window.location.hash` triggers a `hashchange` event
      // that `setUuid` will pick up. Doing it this way keeps the
      // browser history consistent (a back press restores the prior
      // state).
      const target = `#/session/${next}`
      if (window.location.hash !== target) {
        window.location.hash = target
      } else {
        // Already on this URL — fire setter directly so the drawer
        // re-opens after a programmatic close.
        setUuid(next)
      }
    },
    close: () => {
      if (window.location.hash) {
        // `replaceState` instead of clearing `.hash =` because the
        // latter pushes a new entry; replace keeps history clean.
        const cleanUrl = window.location.pathname + window.location.search
        window.history.replaceState(null, '', cleanUrl)
        setUuid(null)
      } else {
        setUuid(null)
      }
    },
  }
}
