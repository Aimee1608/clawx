import { Search } from 'lucide-react'
import { CopyableId } from '@/components/CopyableId'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { relSize, relativeTime } from '@/lib/format'
import type { CodexSessionMeta } from '@/api'

export interface AllCodexSessionsTableProps {
  /** Pre-paginated rows to render. Caller does the slicing. */
  rows: CodexSessionMeta[]
  /** True iff there are zero rows because the initial fetch hasn't landed yet. */
  loading: boolean
  /** True iff filtering removed all rows from a non-empty source set. */
  noMatchAfterFilter: boolean
  error: string | null
  onRowClick: (s: CodexSessionMeta) => void
}

/**
 * Responsive renderer for codex sessions:
 *   - desktop (md+): full 5-column table
 *   - mobile     : full-card list (each card = full-width tappable)
 *
 * Mirrors AllClaudeSessionsTable but with the leaner codex metadata
 * (no first prompt / entrypoint / bot / schedule / chat). Empty /
 * loading / filter-mismatch states each get a tailored visual.
 */
export function AllCodexSessionsTable({
  rows,
  loading,
  noMatchAfterFilter,
  error,
  onRowClick,
}: AllCodexSessionsTableProps): JSX.Element {
  const showLoading = loading && rows.length === 0
  const showError = !showLoading && error
  const showFilterEmpty = !showLoading && !showError && rows.length === 0 && noMatchAfterFilter
  const showFullEmpty = !showLoading && !showError && rows.length === 0 && !noMatchAfterFilter

  return (
    <>
      {/* ── desktop table ─────────────────────────── */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Codex Session ID</TableHead>
              <TableHead>PWD</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Last Modified</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {showLoading ? (
              <SkeletonRows colSpan={5} />
            ) : showError ? (
              <TableRow>
                <TableCell colSpan={5} className="p-0">
                  <EmptyState
                    title="Failed to scan"
                    description={error ?? undefined}
                  />
                </TableCell>
              </TableRow>
            ) : showFilterEmpty ? (
              <TableRow>
                <TableCell colSpan={5} className="p-0">
                  <EmptyState
                    icon={<Search className="h-10 w-10" />}
                    title="No matches"
                    description="Try a wider time range or different search terms."
                  />
                </TableCell>
              </TableRow>
            ) : showFullEmpty ? (
              <TableRow>
                <TableCell colSpan={5} className="p-0">
                  <EmptyState
                    title="No codex sessions"
                    description="~/.codex/sessions/ is empty on this host."
                  />
                </TableCell>
              </TableRow>
            ) : (
              rows.map((s) => (
                <TableRow key={s.id} onClick={() => onRowClick(s)} className="cursor-pointer">
                  <TableCell>
                    <div onClick={(e) => e.stopPropagation()}>
                      <CopyableId value={s.id} label="codex session id" />
                    </div>
                  </TableCell>
                  <TableCell
                    className="max-w-[320px] truncate font-mono text-xs text-muted-foreground"
                    title={s.cwd ?? '—'}
                  >
                    {s.cwd ?? '—'}
                  </TableCell>
                  <TableCell
                    className="whitespace-nowrap text-xs text-muted-foreground"
                    title={s.createdAt ?? ''}
                  >
                    {s.createdAt ? relativeTime(Date.parse(s.createdAt)) : '—'}
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                    {relSize(s.sizeBytes)}
                  </TableCell>
                  <TableCell
                    className="whitespace-nowrap text-xs text-muted-foreground"
                    title={s.lastModified}
                  >
                    {relativeTime(Date.parse(s.lastModified))}
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
          <EmptyState title="Failed to scan" description={error ?? undefined} />
        ) : showFilterEmpty ? (
          <EmptyState
            icon={<Search className="h-12 w-12" />}
            title="No matches"
            description="Try a wider time range or different search terms."
          />
        ) : showFullEmpty ? (
          <EmptyState
            title="No codex sessions"
            description="~/.codex/sessions/ is empty on this host."
          />
        ) : (
          rows.map((s) => (
            <button
              type="button"
              key={s.id}
              onClick={() => onRowClick(s)}
              className="block w-full px-4 py-4 text-left transition-colors active:bg-muted"
            >
              <div className="flex items-start justify-between gap-2">
                <div
                  className="min-w-0 flex-1 truncate text-sm font-medium"
                  title={s.cwd ?? '—'}
                >
                  {s.cwd ?? '—'}
                </div>
                <span
                  className="shrink-0 text-[11px] text-muted-foreground"
                  title={s.lastModified}
                >
                  {relativeTime(Date.parse(s.lastModified))}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span className="font-mono">{relSize(s.sizeBytes)}</span>
                {s.createdAt ? (
                  <>
                    <span>·</span>
                    <span>created {relativeTime(Date.parse(s.createdAt))}</span>
                  </>
                ) : null}
              </div>
              <div className="mt-2 break-all font-mono text-[10px] text-muted-foreground/80">{s.id}</div>
            </button>
          ))
        )}
      </div>
    </>
  )
}

function SkeletonRows({ colSpan }: { colSpan: number }): JSX.Element {
  return (
    <>
      {[0, 1, 2, 3].map((i) => (
        <TableRow key={i}>
          <TableCell colSpan={colSpan} className="py-3">
            <div className="flex items-center gap-3">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 flex-1 max-w-[280px]" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-12" />
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
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="space-y-2 px-4 py-4">
          <div className="flex items-start justify-between gap-2">
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="h-3 w-12" />
          </div>
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="h-4 w-full" />
        </div>
      ))}
    </>
  )
}
