import { CalendarClock, Pencil, Play, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatLocalTime, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { Schedule } from '@/api'

function TriggerCell({ s }: { s: Schedule }): JSX.Element {
  if (s.fireAt) {
    const t = Date.parse(s.fireAt)
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <Badge variant="outline" className="text-[10px]">one-off</Badge>
        <code className="font-mono text-muted-foreground" title={s.fireAt}>
          {Number.isFinite(t) ? formatLocalTime(t) : s.fireAt}
        </code>
      </div>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <code className="font-mono">{s.cron ?? '—'}</code>
      {s.timezone ? (
        <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">{s.timezone}</span>
      ) : null}
    </div>
  )
}

export interface ScheduleTableProps {
  schedules: Schedule[]
  loading: boolean
  onEdit: (s: Schedule) => void
  onToggle: (s: Schedule, enabled: boolean) => void
  onDelete: (s: Schedule) => void
  onRunNow: (s: Schedule) => void
  /** Set of ids currently mid-action so the row's buttons can disable / spin. */
  busyIds?: ReadonlySet<string>
}

/**
 * Tabular list of schedules. Desktop: full table. Mobile: stacked cards.
 *
 * The table is intentionally pure-presentational. All side effects flow
 * through the callbacks; the parent (SchedulesTab) owns the `useSchedules`
 * hook and the form drawer state.
 */
export function ScheduleTable({
  schedules,
  loading,
  onEdit,
  onToggle,
  onDelete,
  onRunNow,
  busyIds,
}: ScheduleTableProps): JSX.Element {
  return (
    <>
      {/* desktop */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[26%]">Name</TableHead>
              <TableHead>Trigger · Kind</TableHead>
              <TableHead>Next run</TableHead>
              <TableHead>Last run</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && schedules.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-3">
                  <div className="flex flex-col gap-2">
                    {[0, 1, 2].map((i) => (
                      <Skeleton key={i} className="h-8 w-full" />
                    ))}
                  </div>
                </TableCell>
              </TableRow>
            ) : schedules.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="p-0">
                  <EmptyState
                    icon={<CalendarClock className="h-10 w-10" />}
                    title="No schedules yet"
                    description="Create one to have claude run a recurring task and DM you the result."
                  />
                </TableCell>
              </TableRow>
            ) : (
              schedules.map((s) => (
                <TableRow key={s.id} className={cn(!s.enabled && 'opacity-60')}>
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium">{s.name}</span>
                      {s.lastError ? (
                        <span className="text-[11px] text-destructive truncate" title={s.lastError}>
                          ⚠ {s.lastError.slice(0, 70)}
                        </span>
                      ) : s.lastResultPreview ? (
                        <span className="truncate text-[11px] text-muted-foreground" title={s.lastResultPreview}>
                          {s.lastResultPreview}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <TriggerCell s={s} />
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge variant="outline" className="w-fit text-[10px]">
                          {s.kind}
                        </Badge>
                        {s.kind === 'prompt' && s.agentKind === 'codex' ? (
                          <Badge variant="secondary" className="w-fit text-[10px]">
                            codex
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {s.enabled ? (
                      s.nextRuns?.[0] ? (
                        <span title={s.nextRuns[0]}>{relativeTime(Date.parse(s.nextRuns[0]))}</span>
                      ) : (
                        '—'
                      )
                    ) : (
                      <span className="italic">paused</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {s.lastRunAt ? (
                      <span title={s.lastRunAt}>{relativeTime(Date.parse(s.lastRunAt))}</span>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <RowActions
                      schedule={s}
                      busy={busyIds?.has(s.id) ?? false}
                      onEdit={onEdit}
                      onToggle={onToggle}
                      onDelete={onDelete}
                      onRunNow={onRunNow}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* mobile */}
      <div className="divide-y md:hidden">
        {loading && schedules.length === 0 ? (
          <div className="space-y-2 px-4 py-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        ) : schedules.length === 0 ? (
          <EmptyState
            icon={<CalendarClock className="h-12 w-12" />}
            title="No schedules yet"
            description="Tap the + button to create one."
          />
        ) : (
          schedules.map((s) => (
            <div key={s.id} className={cn('space-y-2 px-4 py-4', !s.enabled && 'opacity-60')}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{s.name}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                    <TriggerCell s={s} />
                    <Badge variant="outline" className="text-[10px]">
                      {s.kind}
                    </Badge>
                    {s.kind === 'prompt' && s.agentKind === 'codex' ? (
                      <Badge variant="secondary" className="text-[10px]">
                        codex
                      </Badge>
                    ) : null}
                    {!s.enabled && <span className="italic text-muted-foreground">paused</span>}
                  </div>
                </div>
                <RowActions
                  schedule={s}
                  busy={busyIds?.has(s.id) ?? false}
                  onEdit={onEdit}
                  onToggle={onToggle}
                  onDelete={onDelete}
                  onRunNow={onRunNow}
                  compact
                />
              </div>
              {s.lastError ? (
                <div className="text-[11px] text-destructive">⚠ {s.lastError}</div>
              ) : s.lastResultPreview ? (
                <div className="line-clamp-2 text-xs text-muted-foreground">{s.lastResultPreview}</div>
              ) : null}
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span title={s.nextRuns?.[0] ?? ''}>
                  next: {s.enabled && s.nextRuns?.[0] ? relativeTime(Date.parse(s.nextRuns[0])) : '—'}
                </span>
                <span title={s.lastRunAt ?? ''}>
                  last: {s.lastRunAt ? formatLocalTime(Date.parse(s.lastRunAt)) : '—'}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  )
}

function RowActions({
  schedule: s,
  busy,
  onEdit,
  onToggle,
  onDelete,
  onRunNow,
  compact = false,
}: {
  schedule: Schedule
  busy: boolean
  onEdit: ScheduleTableProps['onEdit']
  onToggle: ScheduleTableProps['onToggle']
  onDelete: ScheduleTableProps['onDelete']
  onRunNow: ScheduleTableProps['onRunNow']
  compact?: boolean
}): JSX.Element {
  return (
    <div className={cn('flex items-center gap-1', !compact && 'justify-end')}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        disabled={busy}
        onClick={() => onRunNow(s)}
        title="run now"
        aria-label="run now"
      >
        <Play className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={() => onEdit(s)}
        title="edit"
        aria-label="edit"
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      <button
        type="button"
        role="switch"
        aria-checked={s.enabled}
        onClick={() => onToggle(s, !s.enabled)}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
          s.enabled ? 'bg-primary' : 'bg-muted',
        )}
        title={s.enabled ? 'disable' : 'enable'}
      >
        <span
          className={cn(
            'inline-block h-4 w-4 transform rounded-full bg-background shadow transition-transform',
            s.enabled ? 'translate-x-4' : 'translate-x-0.5',
          )}
        />
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-destructive hover:text-destructive"
        onClick={() => onDelete(s)}
        title="delete"
        aria-label="delete"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
