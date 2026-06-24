import * as React from 'react'
import { RefreshCw, LayoutGrid } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { SessionCard } from '@/components/SessionCard'
import { useTmuxSessions } from '@/hooks/useTmuxSessions'
import { useTmuxStates } from '@/hooks/useTmuxStates'
import type { TmuxSessionEntry, TmuxSessionState } from '@/api'

/**
 * Board columns, left → right. Each is a swimlane that holds the sessions
 * currently in that status — a Kanban-style progress board rather than one
 * flat grid. Attention-needing states sit on the left.
 */
const COLUMNS: ReadonlyArray<{
  status: TmuxSessionState['status']
  label: string
  head: string
  dot: string
  ring: string
}> = [
  {
    status: 'working',
    label: '工作中',
    head: 'text-emerald-700 dark:text-emerald-300',
    dot: 'bg-emerald-500',
    ring: 'border-emerald-500/30 bg-emerald-500/5',
  },
  {
    status: 'stuck',
    label: '卡住',
    head: 'text-red-700 dark:text-red-300',
    dot: 'bg-red-500',
    ring: 'border-red-500/30 bg-red-500/5',
  },
  {
    status: 'idle',
    label: '空闲',
    head: 'text-zinc-600 dark:text-zinc-300',
    dot: 'bg-zinc-400',
    ring: 'border-border bg-muted/30',
  },
  {
    status: 'offline',
    label: '离线',
    head: 'text-zinc-400',
    dot: 'bg-zinc-300',
    ring: 'border-border bg-muted/20',
  },
]

export interface OverviewTabProps {
  /** Open the messages drawer for a session (shared with the Tmux tab). */
  onOpenSession: (e: TmuxSessionEntry) => void
}

/**
 * Kanban-style board of every clawx tmux session: one column per status
 * (working / stuck / idle / offline), cards sorted within a column by most
 * recent activity. The "glance at all my tasks" view. List polls at 3s,
 * statuses at 6s; a refresh on reconnect rehydrates everything.
 */
export function OverviewTab({ onOpenSession }: OverviewTabProps): JSX.Element {
  const { sessions, loading, error, refresh, kill } = useTmuxSessions(3_000)
  const states = useTmuxStates(6_000)

  // Bucket sessions into their column, each bucket sorted newest-activity first.
  const byStatus = React.useMemo(() => {
    const buckets: Record<TmuxSessionState['status'], TmuxSessionEntry[]> = {
      working: [],
      stuck: [],
      idle: [],
      offline: [],
    }
    for (const e of sessions) {
      const status = states.get(e.sessionId)?.status ?? 'idle'
      buckets[status].push(e)
    }
    for (const k of Object.keys(buckets) as TmuxSessionState['status'][]) {
      buckets[k].sort(
        (a, b) =>
          (Date.parse(b.lastTurnAt ?? b.createdAt) || 0) -
          (Date.parse(a.lastTurnAt ?? a.createdAt) || 0),
      )
    }
    return buckets
  }, [sessions, states])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <LayoutGrid className="h-4 w-4" />
          会话看板
          <span className="text-muted-foreground">({sessions.length})</span>
        </h2>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void refresh()}
          className="ml-auto h-8 gap-1"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          刷新
        </Button>
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
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-3">
          {COLUMNS.map((col) => {
            const items = byStatus[col.status]
            return (
              <div
                key={col.status}
                className={`flex w-72 shrink-0 flex-col rounded-lg border ${col.ring}`}
              >
                <div
                  className={`flex items-center gap-2 px-3 py-2 text-xs font-semibold ${col.head}`}
                >
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
                    items.map((entry) => (
                      <SessionCard
                        key={entry.sessionId}
                        entry={entry}
                        state={states.get(entry.sessionId)}
                        onOpen={onOpenSession}
                        onKill={kill}
                      />
                    ))
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
