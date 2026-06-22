import { usePolling } from './usePolling'
import {
  api,
  type StatusResponse,
  type ConfigResponse,
  type ClaudeSessionMeta,
  type CodexSessionMeta,
  type RoomMeta,
} from '@/api'

/**
 * Top-of-page composite hook: status + all-claude sessions + config.
 *
 * - status: 5s — uptime / mode bits
 * - all-claude sessions: 10s — large scan of ~/.claude/projects, doesn't
 *   move on hot timescales
 * - config: not polled — refetched only after an explicit save
 *
 * The bot-session subsystem (queue + worker + SessionStore polling) was
 * retired in the tmux-only refactor; SessionStore lives on the backend
 * but isn't surfaced here.
 */
export function useDashboardData() {
  const status = usePolling<StatusResponse>({
    fetcher: () => api.status(),
    intervalMs: 5000,
  })
  const allClaude = usePolling<{ sessions: ClaudeSessionMeta[]; root: string }>({
    fetcher: () => api.allClaudeSessions(),
    intervalMs: 10_000,
  })
  const allCodex = usePolling<{ sessions: CodexSessionMeta[]; root: string }>({
    fetcher: () => api.allCodexSessions(),
    intervalMs: 10_000,
  })
  const rooms = usePolling<{ rooms: RoomMeta[] }>({
    fetcher: () => api.rooms(),
    intervalMs: 10_000,
  })
  const config = usePolling<ConfigResponse>({
    fetcher: () => api.config(),
    intervalMs: null,
  })

  // The web chat subsystem (and its SessionStore email derivation) was
  // retired in the tmux-only refactor, so there's no per-user identity to
  // surface here anymore. TopBar still accepts a `user` prop; we pass null.
  const currentUser = null

  return {
    status: status.data,
    allClaudeSessions: allClaude.data?.sessions ?? [],
    allClaudeLoading: allClaude.loading,
    allClaudeError: allClaude.error,
    refreshAllClaude: allClaude.refresh,
    allCodexSessions: allCodex.data?.sessions ?? [],
    allCodexLoading: allCodex.loading,
    allCodexError: allCodex.error,
    refreshAllCodex: allCodex.refresh,
    rooms: rooms.data?.rooms ?? [],
    roomsLoading: rooms.loading,
    roomsError: rooms.error,
    refreshRooms: rooms.refresh,
    config: config.data,
    refreshConfig: config.refresh,
    currentUser,
  }
}
