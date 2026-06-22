import { RefreshCw, Users } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { CopyableId } from '@/components/CopyableId'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { RoomMeta, RoomStatus } from '@/api'

export interface RoomsTableProps {
  rooms: RoomMeta[]
  loading: boolean
  error: string | null
  /** When provided, renders a manual refresh button in the header. */
  onRefresh?: () => Promise<void> | void
}

/** Status → badge variant. `running` reads as healthy/green; `ended` is
 * muted; the in-between states get a neutral chip. */
function StatusBadge({ status }: { status: RoomStatus }): JSX.Element {
  const variant =
    status === 'running'
      ? 'success'
      : status === 'ended'
        ? 'outline'
        : 'secondary'
  return (
    <Badge variant={variant} className="text-[10px] capitalize">
      {status}
    </Badge>
  )
}

/**
 * Read-only list of forge-room multi-agent teams — the web mirror of
 * `clawx room ls`. Mirrors the AllCodexSessions panel shape (Card header +
 * responsive table / card list) but carries no filters or pagination:
 * rooms are few and the view is purely informational. Clicking a row does
 * nothing for now (no detail view yet).
 */
export function RoomsTable({ rooms, loading, error, onRefresh }: RoomsTableProps): JSX.Element {
  const showLoading = loading && rooms.length === 0
  const showError = !showLoading && !!error
  const showEmpty = !showLoading && !showError && rooms.length === 0

  return (
    <Card>
      <div className="flex items-start justify-between gap-4 border-b px-6 py-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold leading-none tracking-tight">Rooms on this Host</h2>
          <p className="text-sm text-muted-foreground">
            Forge-room multi-agent teams — the web mirror of{' '}
            <code className="font-mono">clawx room ls</code>.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="secondary" className="font-mono">
            {rooms.length}
          </Badge>
          {onRefresh ? (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => void onRefresh()}
              title="Refresh"
              aria-label="refresh"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            </Button>
          ) : null}
        </div>
      </div>

      {/* ── desktop table ─────────────────────────── */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>RID</TableHead>
              <TableHead>Label</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>CWD</TableHead>
              <TableHead>Template</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {showLoading ? (
              <SkeletonRows colSpan={6} />
            ) : showError ? (
              <TableRow>
                <TableCell colSpan={6} className="p-0">
                  <EmptyState title="Failed to load rooms" description={error ?? undefined} />
                </TableCell>
              </TableRow>
            ) : showEmpty ? (
              <TableRow>
                <TableCell colSpan={6} className="p-0">
                  <EmptyState
                    icon={<Users className="h-10 w-10" />}
                    title="No rooms"
                    description="Start one with `clawx room run`."
                  />
                </TableCell>
              </TableRow>
            ) : (
              rooms.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <div onClick={(e) => e.stopPropagation()}>
                      <CopyableId value={r.id} label="room id" />
                    </div>
                  </TableCell>
                  <TableCell className="max-w-[280px] truncate text-sm" title={r.label}>
                    {r.label}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} />
                  </TableCell>
                  <TableCell
                    className="max-w-[320px] truncate font-mono text-xs text-muted-foreground"
                    title={r.cwd}
                  >
                    {r.cwd}
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                    {r.template ?? '—'}
                  </TableCell>
                  <TableCell
                    className="whitespace-nowrap text-xs text-muted-foreground"
                    title={new Date(r.createdAt).toISOString()}
                  >
                    {relativeTime(r.createdAt)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* ── mobile card list ──────────────────────── */}
      <div className="divide-y md:hidden">
        {showLoading ? (
          <MobileSkeletonCards />
        ) : showError ? (
          <EmptyState title="Failed to load rooms" description={error ?? undefined} />
        ) : showEmpty ? (
          <EmptyState
            icon={<Users className="h-12 w-12" />}
            title="No rooms"
            description="Start one with `clawx room run`."
          />
        ) : (
          rooms.map((r) => (
            <div key={r.id} className="px-4 py-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1 truncate text-sm font-medium" title={r.label}>
                  {r.label}
                </div>
                <StatusBadge status={r.status} />
              </div>
              <div
                className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
                title={r.cwd}
              >
                {r.cwd}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span className="font-mono">{r.id}</span>
                {r.template ? (
                  <>
                    <span>·</span>
                    <span className="font-mono">{r.template}</span>
                  </>
                ) : null}
                <span>·</span>
                <span>created {relativeTime(r.createdAt)}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </Card>
  )
}

function SkeletonRows({ colSpan }: { colSpan: number }): JSX.Element {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <TableRow key={i}>
          <TableCell colSpan={colSpan} className="py-3">
            <div className="flex items-center gap-3">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 flex-1 max-w-[200px]" />
              <Skeleton className="h-4 w-14" />
              <Skeleton className="h-4 flex-1 max-w-[260px]" />
              <Skeleton className="h-4 w-16" />
            </div>
          </TableCell>
        </TableRow>
      ))}
    </>
  )
}

function MobileSkeletonCards(): JSX.Element {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-2 px-4 py-4">
          <div className="flex items-start justify-between gap-2">
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="h-4 w-14" />
          </div>
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ))}
    </>
  )
}
