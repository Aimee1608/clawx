import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Toaster, toast } from 'sonner'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TopBar } from '@/components/TopBar'
import { AllClaudeSessionsPanel } from '@/components/AllClaudeSessionsPanel'
import { AllCodexSessionsPanel } from '@/components/AllCodexSessionsPanel'
import { RoomsTable } from '@/components/RoomsTable'
import { ConfigDrawer } from '@/components/ConfigDrawer'
import { MessagesDrawer } from '@/components/MessagesDrawer'
import { SchedulesTab } from '@/components/SchedulesTab'
import { TmuxTab } from '@/components/TmuxTab'
import { useDashboardData } from '@/hooks/useDashboardData'
import { useSessionMessages, type MessageFetcher } from '@/hooks/useSessionMessages'
import { useSessionHashRoute } from '@/hooks/useSessionHashRoute'
import { useTabRoute } from '@/hooks/useTabRoute'
import { api, type ClaudeSessionMeta, type CodexSessionMeta, type TmuxSessionEntry } from '@/api'

/**
 * In-memory cache of the most recent click-derived subtitle keyed by uuid.
 * When the drawer opens via a hash deep-link (no prior click), there's no
 * subtitle to render — but if the user previously clicked the row in this
 * session we still have the rich label cached. Falls back to a generic
 * subtitle on a fresh page load.
 */
type SubtitleCache = Map<string, React.ReactNode>

/**
 * Root component: composes the dashboard hooks + the leaf presentational
 * pieces. Keeps almost no logic of its own — fetching is in the hooks/,
 * rendering is in components/.
 *
 * The messages drawer is **hash-routable**: clicking a row pushes
 * `#/session/<uuid>` so the URL becomes shareable / refreshable, and the
 * browser back button closes the drawer naturally. See `useSessionHashRoute`.
 */
export function App(): JSX.Element {
  const data = useDashboardData()
  const route = useSessionHashRoute()
  const tabRoute = useTabRoute()

  const [configOpen, setConfigOpen] = useState(false)
  const [savingConfig, setSavingConfig] = useState(false)
  const [subtitleCache] = useState<SubtitleCache>(() => new Map())
  // When the drawer is opened from the Tmux tab, this holds the full
  // tmux session entry so onSend routes to send-keys (instead of the
  // one-shot --resume reply), the drawer offers the Raw toggle, and the
  // header can surface the `tmux attach` command + thread id.
  // Cleared when the drawer closes or a non-tmux row is opened.
  const [tmuxBoundEntry, setTmuxBoundEntry] = useState<TmuxSessionEntry | null>(null)
  // When the drawer is opened from the All Codex Sessions tab, this holds
  // the codex session id so the fetcher routes to the generic agent
  // transcript reader (codex transcripts live under ~/.codex/sessions, not
  // ~/.claude/projects, and the id isn't a claude uuid). Cleared on close
  // or when a non-codex row is opened.
  const [codexBoundId, setCodexBoundId] = useState<string | null>(null)

  // Derive a fetcher target from the URL hash. Defaults to
  // `claudeSessionMessages` because it works for any uuid found under
  // ~/.claude/projects/ — covers both bot and non-bot sessions with one
  // code path. Tmux/codex rows bind their own kind so the fetcher routes
  // to the right transcript source. Subtitle comes from cache if the user
  // just clicked, or a generic fallback if they deep-linked.
  const messagesTarget: MessageFetcher | null = useMemo(() => {
    if (!route.uuid) return null
    if (codexBoundId && codexBoundId === route.uuid) {
      return { uuid: route.uuid, fetch: (id) => api.agentSessionMessages('codex', id) }
    }
    if (tmuxBoundEntry) {
      const kind = tmuxBoundEntry.agentKind ?? 'claude'
      return {
        uuid: route.uuid,
        fetch: (id) => kind === 'codex'
          ? api.agentSessionMessages('codex', id)
          : api.claudeSessionMessages(id),
      }
    }
    return { uuid: route.uuid, fetch: api.claudeSessionMessages }
  }, [route.uuid, tmuxBoundEntry, codexBoundId])

  const messagesState = useSessionMessages(messagesTarget)

  function openClaudeMessages(s: ClaudeSessionMeta): void {
    subtitleCache.set(
      s.uuid,
      <>
        Claude session <span className="font-mono text-xs">{s.uuid.slice(0, 8)}</span>
        {s.entrypoint ? (
          <>
            {' · via '}
            <span className="font-mono text-xs">{s.entrypoint}</span>
          </>
        ) : null}
        {' · '}
        <span className="font-mono text-xs">{s.cwd ?? s.projectDir}</span>
      </>,
    )
    setTmuxBoundEntry(null) // explicit: not a tmux row
    setCodexBoundId(null) // explicit: not a codex row
    route.open(s.uuid)
  }

  function openCodexMessages(s: CodexSessionMeta): void {
    subtitleCache.set(
      s.id,
      <>
        Codex session <span className="font-mono text-xs">{s.id.slice(0, 8)}</span>
        {s.cwd ? (
          <>
            {' · '}
            <span className="font-mono text-xs">{s.cwd}</span>
          </>
        ) : null}
      </>,
    )
    setTmuxBoundEntry(null) // explicit: not a tmux row
    setCodexBoundId(s.id) // route the fetcher to the codex transcript reader
    route.open(s.id)
  }

  function openTmuxSession(e: TmuxSessionEntry): void {
    const agentKind = e.agentKind ?? 'claude'
    const agentSessionId = e.agentSessionId ?? e.claudeUuid
    if (!agentSessionId) {
      toast.error('该 session 还没分配 agent id，稍后再试')
      return
    }
    subtitleCache.set(
      agentSessionId,
      <>
        Tmux <span className="font-mono text-xs">{e.sessionId}</span>
        {' · '}
        <span className="font-mono text-xs">{agentKind}</span>
        {' · '}
        <span className="font-mono text-xs">{e.cwd}</span>
        {e.threadId ? (
          <>
            {' · '}
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
              Lark thread
            </span>
          </>
        ) : null}
      </>,
    )
    setTmuxBoundEntry(e)
    setCodexBoundId(null) // explicit: not an All-Codex-tab row
    route.open(agentSessionId)
  }

  async function onSaveConfig(body: Record<string, string>): Promise<void> {
    if (Object.keys(body).length === 0) {
      toast.warning('Nothing to save — blank fields keep existing values')
      return
    }
    setSavingConfig(true)
    try {
      await api.saveConfig(body)
      toast.success('Saved. Restart clawx to apply.')
      await data.refreshConfig()
    } catch (err: any) {
      toast.error(`Save failed: ${err?.message ?? String(err)}`)
    } finally {
      setSavingConfig(false)
    }
  }

  // Document title reflects the current view so browser tabs and bookmarks
  // are scannable.
  useEffect(() => {
    document.title = route.uuid ? `session ${route.uuid.slice(0, 8)} · clawx` : 'clawx'
    return () => {
      document.title = 'clawx'
    }
  }, [route.uuid])

  // Subtitle resolution: prefer the cached rich label if we have one;
  // otherwise show a minimal fallback (just the uuid prefix).
  const subtitle: React.ReactNode = route.uuid
    ? (subtitleCache.get(route.uuid) ?? (
        <>
          Claude session <span className="font-mono text-xs">{route.uuid.slice(0, 8)}</span> · deep link
        </>
      ))
    : null

  return (
    <div className="min-h-screen bg-background text-foreground">
      <TopBar status={data.status} user={data.currentUser} onOpenConfig={() => setConfigOpen(true)} />

      <main className="mx-auto max-w-screen-2xl space-y-6 px-4 py-6 sm:px-6 sm:py-8">
        {/* Top-level tabs: Sessions | Schedules. The active top-level is
            derived from the flat tab route — any `sessions:*` value lights
            up "Sessions"; "schedules" lights up Schedules. Switching the
            top-level tab lands on a sensible default sub-view. */}
        <Tabs
          value={tabRoute.tab === 'schedules' ? 'schedules' : 'sessions'}
          onValueChange={(v) => tabRoute.setTab(v === 'schedules' ? 'schedules' : 'sessions:tmux')}
        >
          <TabsList>
            <TabsTrigger value="sessions">Sessions</TabsTrigger>
            <TabsTrigger value="schedules">Schedules</TabsTrigger>
          </TabsList>

          <TabsContent value="sessions">
            {/* Second-level tabs: Tmux | Claude | Codex | Room. Bound to the
                full flat route value so refresh / deep-links restore the
                exact sub-view. */}
            <Tabs
              value={tabRoute.tab === 'schedules' ? 'sessions:tmux' : tabRoute.tab}
              onValueChange={(v) => tabRoute.setTab(v as typeof tabRoute.tab)}
            >
              <TabsList>
                <TabsTrigger value="sessions:tmux">Tmux</TabsTrigger>
                <TabsTrigger value="sessions:claude">Claude</TabsTrigger>
                <TabsTrigger value="sessions:codex">Codex</TabsTrigger>
                <TabsTrigger value="sessions:room">Room</TabsTrigger>
              </TabsList>

              <TabsContent value="sessions:tmux">
                <TmuxTab onOpenSession={openTmuxSession} />
              </TabsContent>

              <TabsContent value="sessions:claude">
                <AllClaudeSessionsPanel
                  sessions={data.allClaudeSessions}
                  loading={data.allClaudeLoading}
                  error={data.allClaudeError}
                  onRowClick={openClaudeMessages}
                  onRefresh={data.refreshAllClaude}
                />
              </TabsContent>

              <TabsContent value="sessions:codex">
                <AllCodexSessionsPanel
                  sessions={data.allCodexSessions}
                  loading={data.allCodexLoading}
                  error={data.allCodexError}
                  onRowClick={openCodexMessages}
                  onRefresh={data.refreshAllCodex}
                />
              </TabsContent>

              <TabsContent value="sessions:room">
                <RoomsTable
                  rooms={data.rooms}
                  loading={data.roomsLoading}
                  error={data.roomsError}
                  onRefresh={data.refreshRooms}
                />
              </TabsContent>
            </Tabs>
          </TabsContent>

          <TabsContent value="schedules">
            <SchedulesTab defaultCwd={data.config?.config.claudeCwd} />
          </TabsContent>
        </Tabs>
      </main>

      <ConfigDrawer
        open={configOpen}
        cfg={data.config}
        saving={savingConfig}
        onOpenChange={setConfigOpen}
        onSubmit={onSaveConfig}
      />
      <MessagesDrawer
        open={route.uuid !== null}
        subtitle={subtitle}
        messages={messagesState.messages}
        loading={messagesState.loading}
        error={messagesState.error}
        note={messagesState.note}
        lastModifiedMs={messagesState.lastModifiedMs}
        nowMs={messagesState.nowMs}
        tmuxSid={tmuxBoundEntry?.sessionId ?? null}
        tmuxAttachCmd={
          tmuxBoundEntry ? `tmux attach -t ${tmuxBoundEntry.tmuxName}` : null
        }
        tmuxThreadId={tmuxBoundEntry?.threadId ?? null}
        onOpenChange={(v) => {
          if (!v) {
            route.close()
            setTmuxBoundEntry(null)
            setCodexBoundId(null)
          }
        }}
      />
      <Toaster richColors closeButton position="top-right" />
    </div>
  )
}
