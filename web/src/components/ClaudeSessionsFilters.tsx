import { useState } from 'react'
import { Filter, Search as SearchIcon, X as XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

export type TimeFilter = 'all' | '1h' | '24h' | '7d' | '30d'

export const TIME_FILTER_OPTIONS: Array<{ key: TimeFilter; label: string; ms: number | null }> = [
  { key: '1h', label: 'Last 1h', ms: 60 * 60_000 },
  { key: '24h', label: 'Last 24h', ms: 24 * 60 * 60_000 },
  { key: '7d', label: 'Last 7d', ms: 7 * 24 * 60 * 60_000 },
  { key: '30d', label: 'Last 30d', ms: 30 * 24 * 60 * 60_000 },
  { key: 'all', label: 'All', ms: null },
]

export type SourceFilter = 'all' | 'human' | 'schedule'

export const SOURCE_FILTER_OPTIONS: Array<{ key: SourceFilter; label: string }> = [
  { key: 'all', label: 'All sources' },
  { key: 'human', label: 'Human' },
  { key: 'schedule', label: 'Schedule' },
]

export interface ClaudeSessionsFiltersProps {
  timeFilter: TimeFilter
  search: string
  onTimeFilterChange: (v: TimeFilter) => void
  onSearchChange: (v: string) => void
  /** Optional. When provided, renders the source chip group too. */
  sourceFilter?: SourceFilter
  onSourceFilterChange?: (v: SourceFilter) => void
}

/**
 * Time-range chip group + free-text search input.
 *
 * Layouts:
 *   - desktop (sm+): all-inline — chip group on the left, search on the right
 *   - mobile  (<sm): inline search + small "Filter" button. Tapping the
 *                    button opens a bottom sheet with the time chips,
 *                    matching iOS / Android list-filter conventions.
 *
 * Active time filter shows as a small dot on the mobile button so the user
 * knows a non-default filter is in play without opening the sheet.
 */
export function ClaudeSessionsFilters({
  timeFilter,
  search,
  onTimeFilterChange,
  onSearchChange,
  sourceFilter,
  onSourceFilterChange,
}: ClaudeSessionsFiltersProps): JSX.Element {
  const [sheetOpen, setSheetOpen] = useState(false)
  const activeLabel = TIME_FILTER_OPTIONS.find((o) => o.key === timeFilter)?.label ?? ''
  const showSource = sourceFilter !== undefined && onSourceFilterChange !== undefined

  return (
    <>
      {/* ── desktop: chips inline + search ─────────── */}
      <div className="hidden sm:flex sm:flex-wrap sm:items-center sm:gap-2">
        <div className="flex flex-wrap items-center gap-1 rounded-md bg-muted p-1">
          {TIME_FILTER_OPTIONS.map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => onTimeFilterChange(o.key)}
              className={cn(
                'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                timeFilter === o.key
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
        {showSource ? (
          <div className="flex flex-wrap items-center gap-1 rounded-md bg-muted p-1">
            {SOURCE_FILTER_OPTIONS.map((o) => (
              <button
                key={o.key}
                type="button"
                onClick={() => onSourceFilterChange!(o.key)}
                className={cn(
                  'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                  sourceFilter === o.key
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        ) : null}
        <div className="relative ml-auto max-w-md flex-1">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search cwd, prompt, uuid, source…"
            className="h-8 pl-8 pr-8"
          />
          {search ? (
            <button
              type="button"
              onClick={() => onSearchChange('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="clear search"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      {/* ── mobile: search + filter button ─────────── */}
      <div className="flex items-center gap-2 sm:hidden">
        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search…"
            className="h-10 pl-10 pr-10 text-sm"
          />
          {search ? (
            <button
              type="button"
              onClick={() => onSearchChange('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="clear search"
            >
              <XIcon className="h-4 w-4" />
            </button>
          ) : null}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setSheetOpen(true)}
          className="relative h-10 shrink-0 px-3"
        >
          <Filter className="mr-1.5 h-4 w-4" />
          {activeLabel}
          {timeFilter !== '7d' ? (
            <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary" />
          ) : null}
        </Button>

        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="bottom" className="rounded-t-xl">
            <SheetHeader>
              <SheetTitle className="text-left">Time range</SheetTitle>
            </SheetHeader>
            <div className="mt-4 flex flex-col gap-1">
              {TIME_FILTER_OPTIONS.map((o) => (
                <button
                  key={o.key}
                  type="button"
                  onClick={() => {
                    onTimeFilterChange(o.key)
                    setSheetOpen(false)
                  }}
                  className={cn(
                    'flex h-12 items-center justify-between rounded-md px-3 text-left text-sm transition-colors',
                    timeFilter === o.key
                      ? 'bg-primary/10 font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <span>{o.label}</span>
                  {timeFilter === o.key ? (
                    <span className="h-2 w-2 rounded-full bg-primary" />
                  ) : null}
                </button>
              ))}
            </div>
            {showSource ? (
              <>
                <div className="mt-5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Source</div>
                <div className="mt-2 flex flex-col gap-1">
                  {SOURCE_FILTER_OPTIONS.map((o) => (
                    <button
                      key={o.key}
                      type="button"
                      onClick={() => {
                        onSourceFilterChange!(o.key)
                        setSheetOpen(false)
                      }}
                      className={cn(
                        'flex h-12 items-center justify-between rounded-md px-3 text-left text-sm transition-colors',
                        sourceFilter === o.key
                          ? 'bg-primary/10 font-medium text-foreground'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                    >
                      <span>{o.label}</span>
                      {sourceFilter === o.key ? (
                        <span className="h-2 w-2 rounded-full bg-primary" />
                      ) : null}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </SheetContent>
        </Sheet>
      </div>
    </>
  )
}
