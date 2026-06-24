import * as React from 'react'
import { RefreshCw, LayoutGrid, Columns3, FolderGit2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { SessionCard } from '@/components/SessionCard'
import { useTmuxSessions } from '@/hooks/useTmuxSessions'
import { useTmuxStates } from '@/hooks/useTmuxStates'
import type { TmuxSessionEntry, TmuxSessionState } from '@/api'

type Status = TmuxSessionState['status']

/** Board columns, left → right. Attention-needing states sit on the left. */
const COLUMNS: ReadonlyArray<{ status: Status; label: string; head: string; dot: string; ring: string }> = [
  { status: 'stuck', label: '卡住', head: 'text-red-700 dark:text-red-300', dot: 'bg-red-500', ring: 'border-red-500/40 bg-red-500/5' },
  { status: 'working', label: '工作中', head: 'text-emerald-700 dark:text-emerald-300', dot: 'bg-emerald-500', ring: 'border-emerald-500/30 bg-emerald-500/5' },
  { status: 'idle', label: '空闲', head: 'text-zinc-600 dark:text-zinc-300', dot: 'bg-zinc-400', ring: 'border-border bg-muted/30' },
  { status: 'offline', label: '离线', head: 'text-zinc-400', dot: 'bg-zinc-300', ring: 'border-border bg-muted/20' },
]

const STATUS_RANK: Record<Status, number> = { stuck: 0, working: 1, idle: 2, offline: 3 }

function basename(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] || cwd || '—'
}

function activityMs(e: TmuxSessionEntry): number {
  return Date.parse(e.lastTurnAt ?? e.createdAt) || 0
}

export interface OverviewTabProps {
  /** Open the messages drawer for a session (shared with the Tmux tab). */
  onOpenSession: (e: TmuxSessionEntry) => void
}

/**
 * Session board. Two views over the same cards:
 *  - `status`: Kanban swimlanes (stuck / working / idle / offline).
 *  - `project`: sections grouped by cwd, each card showing its own status.
 * A summary bar surfaces the counts (stuck highlighted). List polls 3s,
 * statuses 6s; a refresh on reconnect rehydrates everything.
 */
export function OverviewTab({ onOpenSession }: OverviewTabProps): JSX.Element {
  const { sessions, loading, error, refresh, kill } = useTmuxSessions(3_000)
  const states = useTmuxStates(6_000)
  const [view, setView] = React.useState<'status' | 'project'>('status')

  const statusOf = React.useCallback(
    (e: TmuxSessionEntry): Status => states.get(e.sessionId)?.status ?? 'idle',
    [states],
  )

  const counts = React.useMemo(() => {
    const c: Record<Status, number> = { working: 0, stuck: 0, idle: 0, offline: 0 }
    for (const e of sessions) c[statusOf(e)]++
    return c
  }, [sessions, statusOf])

  const byStatus = React.useMemo(() => {
    const buckets: Record<Status, TmuxSessionEntry[]> = { working: [], stuck: [], idle: [], offline: [] }
    for (const e of sessions) buckets[statusOf(e)].push(e)
    for (const k of Object.keys(buckets) as Status[]) buckets[k].sort((a, b) => activityMs(b) - activityMs(a))
    return buckets
  }, [sessions, statusOf])

  const byProject = React.useMemo(() => {
    const groups = new Map<string, TmuxSessionEntry[]>()
    for (const e of sessions) {
      const key = basename(e.cwd)
      const arr = groups.get(key) ?? []
      arr.push(e)
      groups.set(key, arr)
    }
    // Sort each group by attention (status rank) then activity; sort the
    // groups themselves so the project with the most-urgent session leads.
    const entries = [...groups.entries()].map(([name, list]) => {
      list.sort((a, b) => STATUS_RANK[statusOf(a)] - STATUS_RANK[statusOf(b)] || activityMs(b) - activityMs(a))
      return { name, list, lead: Math.min(...list.map((e) => STATUS_RANK[statusOf(e)])) }
    })
    entries.sort((a, b) => a.lead - b.lead || b.list.length - a.list.length)
    return entries
  }, [sessions, statusOf])

  function renderCard(entry: TmuxSessionEntry): JSX.Element {
    return (
      <SessionCard
        key={entry.sessionId}
        entry={entry}
        state={states.get(entry.sessionId)}
        onOpen={onOpenSession}
        onKill={kill}
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <LayoutGrid className="h-4 w-4" />
          会话看板
          <span className="text-muted-foreground">({sessions.length})</span>
        </h2>

        {/* Summary pills — stuck pulses when any session needs attention. */}
        <div className="flex items-center gap-2 text-xs">
          {counts.stuck > 0 ? (
            <span className="flex animate-pulse items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 font-medium text-red-600 dark:text-red-400">
              ● 卡住 {counts.stuck}
            </span>
          ) : null}
          <span className="flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-700 dark:text-emerald-400">
            ● 工作 {counts.working}
          </span>
          <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
            ● 空闲 {counts.idle}
          </span>
          {counts.offline > 0 ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground/60">离线 {counts.offline}</span>
          ) : null}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          {/* View toggle: status board ↔ project grouping. */}
          <div className="flex rounded-md border p-0.5">
            <button
              onClick={() => setView('status')}
              className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${view === 'status' ? 'bg-muted font-medium' : 'text-muted-foreground'}`}
            >
              <Columns3 className="h-3.5 w-3.5" />
              状态
            </button>
            <button
              onClick={() => setView('project')}
              className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${view === 'project' ? 'bg-muted font-medium' : 'text-muted-foreground'}`}
            >
              <FolderGit2 className="h-3.5 w-3.5" />
              项目
            </button>
          </div>
          <Button size="sm" variant="outline" onClick={() => void refresh()} className="h-8 gap-1">
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          加载失败: {error}
        </div>
      ) : null}

      {loading && sessions.length === 0 ? (
        <div className="flex gap-4">
          {COLUMNS.map((c) => (
            <div key={c.status} className="w-72 shrink-0 space-y-3">
              <Skeleton className="h-6 w-24" />
              <Skeleton className="h-40 w-full" />
            </div>
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <div className="rounded-lg border border-dashed py-16 text-center text-sm text-muted-foreground">
          还没有会话 —— 用 `clawx solo` 或飞书私聊起一个,它就会出现在这里。
        </div>
      ) : view === 'status' ? (
        <div className="flex gap-4 overflow-x-auto pb-3">
          {COLUMNS.map((col) => {
            const items = byStatus[col.status]
            return (
              <div key={col.status} className={`flex w-72 shrink-0 flex-col rounded-lg border ${col.ring}`}>
                <div className={`flex items-center gap-2 px-3 py-2 text-xs font-semibold ${col.head}`}>
                  <span className={`inline-block h-2 w-2 rounded-full ${col.dot}`} />
                  {col.label}
                  <span className="ml-auto rounded-full bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {items.length}
                  </span>
                </div>
                <div className="flex flex-col gap-2 p-2">
                  {items.length === 0 ? (
                    <div className="py-6 text-center text-[11px] text-muted-foreground/60">空</div>
                  ) : (
                    items.map(renderCard)
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="space-y-5">
          {byProject.map((group) => (
            <div key={group.name} className="space-y-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                <FolderGit2 className="h-3.5 w-3.5" />
                {group.name}
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px]">{group.list.length}</span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {group.list.map(renderCard)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
