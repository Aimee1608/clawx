import { useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ScheduleTable } from './ScheduleTable'
import { ScheduleFormDrawer } from './ScheduleFormDrawer'
import { useSchedules } from '@/hooks/useSchedules'
import { cn } from '@/lib/utils'
import type { CreateScheduleBody, Schedule } from '@/api'

export interface SchedulesTabProps {
  /** Default cwd for new prompt schedules — pulled up from app config. */
  defaultCwd?: string
}

/**
 * Self-contained "Schedules" tab body. Owns:
 *   - useSchedules() hook for data + mutators
 *   - form drawer open / editing state
 *   - busy-id set so the row can dim during async actions
 *
 * App.tsx only needs to render <SchedulesTab /> and supply defaultCwd.
 */
export function SchedulesTab({ defaultCwd }: SchedulesTabProps): JSX.Element {
  const sched = useSchedules()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Schedule | null>(null)
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set())
  const [refreshing, setRefreshing] = useState(false)

  async function handleRefresh(): Promise<void> {
    if (refreshing) return
    setRefreshing(true)
    try {
      await sched.refresh()
    } finally {
      setRefreshing(false)
    }
  }

  function setBusy(id: string, busy: boolean): void {
    setBusyIds((prev) => {
      const next = new Set(prev)
      if (busy) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function openCreate(): void {
    setEditing(null)
    setFormOpen(true)
  }

  function openEdit(s: Schedule): void {
    setEditing(s)
    setFormOpen(true)
  }

  async function onSubmit(body: CreateScheduleBody, editingId: string | null): Promise<void> {
    if (editingId) {
      await sched.update(editingId, body)
      toast.success('Schedule updated')
    } else {
      await sched.create(body)
      toast.success('Schedule created')
    }
  }

  async function onToggle(s: Schedule, enabled: boolean): Promise<void> {
    setBusy(s.id, true)
    try {
      await sched.update(s.id, { enabled })
      toast.success(`${s.name} ${enabled ? 'enabled' : 'paused'}`)
    } catch (err: any) {
      toast.error(`Toggle failed: ${err?.message ?? String(err)}`)
    } finally {
      setBusy(s.id, false)
    }
  }

  async function onDelete(s: Schedule): Promise<void> {
    // Cheap inline confirm — we're a personal control plane, not a fleet
    // admin tool. A full Dialog would be overkill for the scale of mistake
    // (one removed schedule, recreatable in 30 seconds).
    if (!window.confirm(`Delete schedule "${s.name}"?`)) return
    setBusy(s.id, true)
    try {
      await sched.remove(s.id)
      toast.success(`${s.name} deleted`)
    } catch (err: any) {
      toast.error(`Delete failed: ${err?.message ?? String(err)}`)
    } finally {
      setBusy(s.id, false)
    }
  }

  async function onRunNow(s: Schedule): Promise<void> {
    setBusy(s.id, true)
    try {
      await sched.runNow(s.id)
      toast.success(`${s.name}: dispatched, watch your DMs`)
    } catch (err: any) {
      toast.error(`Run failed: ${err?.message ?? String(err)}`)
    } finally {
      setBusy(s.id, false)
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between border-b px-4 py-4 sm:px-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold leading-none tracking-tight">Schedules</h2>
          <p className="text-sm text-muted-foreground">
            Cron-driven tasks. Each fire spawns claude (or sends a message) and DMs you the result.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {sched.schedules.length > 0 ? (
            <Badge variant="secondary" className="font-mono">
              {sched.schedules.filter((s) => s.enabled).length} / {sched.schedules.length} active
            </Badge>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            title="Refresh"
            aria-label="refresh"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
          </Button>
          <Button type="button" size="sm" onClick={openCreate}>
            <Plus className="mr-1 h-4 w-4" />
            New
          </Button>
        </div>
      </div>

      <ScheduleTable
        schedules={sched.schedules}
        loading={sched.loading}
        onEdit={openEdit}
        onToggle={onToggle}
        onDelete={onDelete}
        onRunNow={onRunNow}
        busyIds={busyIds}
      />

      <ScheduleFormDrawer
        open={formOpen}
        onOpenChange={setFormOpen}
        editing={editing}
        defaultCwd={defaultCwd}
        onSubmit={onSubmit}
      />
    </Card>
  )
}
