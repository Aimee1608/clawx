import { useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { AllCodexSessionsTable } from './AllCodexSessionsTable'
import { ClaudeSessionsFilters, TIME_FILTER_OPTIONS, type TimeFilter } from './ClaudeSessionsFilters'
import { PaginationFooter } from './PaginationFooter'
import { cn } from '@/lib/utils'
import type { CodexSessionMeta } from '@/api'

const PAGE_SIZE_OPTIONS = [25, 50, 100]

export interface AllCodexSessionsPanelProps {
  sessions: CodexSessionMeta[]
  loading: boolean
  error: string | null
  /** Initial time filter; UI state stays internal afterwards. Default '7d'. */
  defaultTimeFilter?: TimeFilter
  onRowClick: (s: CodexSessionMeta) => void
  /** When provided, renders a manual refresh button in the header. */
  onRefresh?: () => Promise<void> | void
}

/**
 * All-machine codex sessions panel. Mirrors AllClaudeSessionsPanel but
 * with the leaner codex metadata: no source/schedule/chat dimension, so
 * the filter bar carries only the time-range chips + free-text search
 * (the shared ClaudeSessionsFilters renders the source group only when
 * given source props — we deliberately omit them).
 */
export function AllCodexSessionsPanel({
  sessions,
  loading,
  error,
  defaultTimeFilter = '7d',
  onRowClick,
  onRefresh,
}: AllCodexSessionsPanelProps): JSX.Element {
  const [timeFilter, setTimeFilter] = useState<TimeFilter>(defaultTimeFilter)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [refreshing, setRefreshing] = useState(false)

  async function handleRefresh(): Promise<void> {
    if (!onRefresh || refreshing) return
    setRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setRefreshing(false)
    }
  }

  const filtered = useMemo(() => {
    const rangeMs = TIME_FILTER_OPTIONS.find((o) => o.key === timeFilter)?.ms ?? null
    const cutoff = rangeMs == null ? 0 : Date.now() - rangeMs
    const q = search.trim().toLowerCase()
    return sessions.filter((s) => {
      if (cutoff > 0 && Date.parse(s.lastModified) < cutoff) return false
      if (q) {
        const haystack = [s.id, s.cwd]
          .filter((v): v is string => typeof v === 'string')
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
  }, [sessions, timeFilter, search])

  // Reset to page 1 whenever filters or dataset shape change.
  useEffect(() => {
    setPage(1)
  }, [timeFilter, search, pageSize, sessions.length])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const start = (safePage - 1) * pageSize
  const paginated = filtered.slice(start, start + pageSize)
  const noMatchAfterFilter = filtered.length === 0 && sessions.length > 0

  return (
    <Card>
      <div className="flex flex-col gap-3 border-b px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold leading-none tracking-tight">All Codex Sessions on this Host</h2>
            <p className="text-sm text-muted-foreground">
              Scan of <span className="font-mono text-xs">~/.codex/sessions/</span> — terminal{' '}
              <code className="font-mono">codex</code> transcripts.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant="secondary" className="font-mono">
              {filtered.length} of {sessions.length}
            </Badge>
            {onRefresh ? (
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
            ) : null}
          </div>
        </div>
        <ClaudeSessionsFilters
          timeFilter={timeFilter}
          search={search}
          onTimeFilterChange={setTimeFilter}
          onSearchChange={setSearch}
        />
      </div>

      <AllCodexSessionsTable
        rows={paginated}
        loading={loading}
        noMatchAfterFilter={noMatchAfterFilter}
        error={error}
        onRowClick={onRowClick}
      />

      {filtered.length > 0 ? (
        <PaginationFooter
          page={safePage}
          pageSize={pageSize}
          totalPages={totalPages}
          totalFiltered={filtered.length}
          totalUnfiltered={sessions.length}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      ) : null}
    </Card>
  )
}
