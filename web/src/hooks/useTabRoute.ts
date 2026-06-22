import { useEffect, useState } from 'react'

/**
 * Synchronize the dashboard's active view with `window.location.hash`.
 *
 * The dashboard has two top-level tabs — `Sessions` and `Schedules` — and
 * `Sessions` nests four sub-tabs (`Tmux | Claude | Codex | Room`). We model
 * this as a single flat string so URL/refresh restore the exact view:
 *
 *   `#/sessions/tmux`   → Sessions › Tmux   (default)
 *   `#/sessions/claude` → Sessions › Claude
 *   `#/sessions/codex`  → Sessions › Codex
 *   `#/sessions/room`   → Sessions › Room
 *   `#/schedules`       → Schedules
 *   `#/session/<uuid>`  → legacy deep-link to the messages drawer; falls
 *                         back to Sessions › Claude so the row the drawer
 *                         overlays is visible behind it.
 *
 * Legacy single-segment hashes from the old flat-tab layout still resolve
 * (`#/tmux`, `#/all`, `#/codex`, `#/schedules`) so old bookmarks keep
 * working.
 *
 * Why hash routing rather than path routing: same reasoning as
 * `useSessionHashRoute` — the dashboard is a SPA without a server-side
 * fallback for arbitrary paths, so hash routing is the safest choice.
 */
export type Tab =
  | 'sessions:tmux'
  | 'sessions:claude'
  | 'sessions:codex'
  | 'sessions:room'
  | 'schedules'

const VALID_TABS: readonly Tab[] = [
  'sessions:tmux',
  'sessions:claude',
  'sessions:codex',
  'sessions:room',
  'schedules',
]

const DEFAULT_TAB: Tab = 'sessions:tmux'

/** Map a `Tab` to its canonical hash. */
function tabToHash(tab: Tab): string {
  if (tab === 'schedules') return '#/schedules'
  // sessions:<sub> → #/sessions/<sub>
  const sub = tab.slice('sessions:'.length)
  return `#/sessions/${sub}`
}

/** Result kind: a tab to switch to, a session deep-link (don't change the
 * tab at runtime), or `default` (unknown/empty hash). */
type ParseResult = { kind: 'tab'; tab: Tab } | { kind: 'session-deep-link' } | { kind: 'default' }

const SESSIONS_SUBTABS: Record<string, Tab> = {
  tmux: 'sessions:tmux',
  claude: 'sessions:claude',
  codex: 'sessions:codex',
  room: 'sessions:room',
}

// Legacy single-segment hashes from the old flat-tab layout.
const LEGACY_TAB_ALIASES: Record<string, Tab> = {
  tmux: 'sessions:tmux',
  all: 'sessions:claude',
  codex: 'sessions:codex',
  room: 'sessions:room',
  schedules: 'schedules',
}

function parseTabImpl(hash: string): ParseResult {
  // Two-segment: #/sessions/<sub>
  const two = /^#\/sessions\/([a-z]+)(?:\/|$)/i.exec(hash)
  if (two) {
    const sub = two[1]!.toLowerCase()
    const tab = SESSIONS_SUBTABS[sub]
    if (tab) return { kind: 'tab', tab }
    // Unknown sub-tab under /sessions → land on the default sub-tab.
    return { kind: 'tab', tab: DEFAULT_TAB }
  }
  // Single-segment: #/<seg> — legacy aliases + #/schedules + #/session/<uuid>
  const one = /^#\/([a-z]+)(?:\/|$)/i.exec(hash)
  if (one) {
    const seg = one[1]!.toLowerCase()
    const alias = LEGACY_TAB_ALIASES[seg]
    if (alias) return { kind: 'tab', tab: alias }
    // `#/session/<uuid>` is the messages drawer's deep-link form. On page
    // load we land on Sessions › Claude so the row behind the drawer is
    // visible (helps pasted URLs). But once the user is interactively
    // using the app and the drawer is opened from a different tab (e.g.
    // Tmux), we keep that tab — see useTabRoute below.
    if (seg === 'session') return { kind: 'session-deep-link' }
  }
  return { kind: 'default' }
}

function initialTab(hash: string): Tab {
  const r = parseTabImpl(hash)
  if (r.kind === 'tab') return r.tab
  if (r.kind === 'session-deep-link') return 'sessions:claude'
  return DEFAULT_TAB
}

export interface TabRoute {
  tab: Tab
  /** Switch to a different tab. Updates the hash so a refresh restores
   * the same view. Replaces any sub-route (e.g. an active conv id) in
   * the existing hash — switching tabs is a top-level action. */
  setTab: (next: Tab) => void
}

export function useTabRoute(): TabRoute {
  const [tab, setTabState] = useState<Tab>(() =>
    typeof window === 'undefined' ? DEFAULT_TAB : initialTab(window.location.hash),
  )

  useEffect(() => {
    function onHashChange(): void {
      const r = parseTabImpl(window.location.hash)
      if (r.kind === 'tab') {
        setTabState(r.tab)
        return
      }
      // Session deep-link or empty hash arriving via interactive
      // navigation — do NOT change the tab. The drawer hook handles
      // its own state, and the tab the user was on should persist.
      // (Page load case is handled in initialTab, separate code path.)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  return {
    tab,
    setTab: (next) => {
      const nextHash = tabToHash(next)
      if (next === tab && window.location.hash === nextHash) return
      window.location.hash = nextHash
      // JSDOM (and some browser quirks) don't always fire `hashchange`
      // synchronously on programmatic assignment, so update state
      // optimistically here. Real `hashchange` events from browser
      // navigation are still picked up by the listener above.
      setTabState(next)
    },
  }
}
