import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'

export interface PaginationFooterProps {
  page: number
  pageSize: number
  totalPages: number
  totalFiltered: number
  totalUnfiltered: number
  pageSizeOptions: number[]
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
}

/**
 * Footer with "Showing X-Y of N (filtered from M)" + page-size selector +
 * prev/next navigation. Pure presentational — caller owns page state.
 */
export function PaginationFooter({
  page,
  pageSize,
  totalPages,
  totalFiltered,
  totalUnfiltered,
  pageSizeOptions,
  onPageChange,
  onPageSizeChange,
}: PaginationFooterProps): JSX.Element {
  const safePage = Math.min(page, totalPages)
  const start = (safePage - 1) * pageSize
  const end = Math.min(start + pageSize, totalFiltered)

  return (
    <div className="flex flex-col gap-3 border-t px-6 py-3 text-xs text-muted-foreground sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      <div>
        Showing <span className="font-medium text-foreground">{totalFiltered === 0 ? 0 : start + 1}</span>–
        <span className="font-medium text-foreground">{end}</span> of{' '}
        <span className="font-medium text-foreground">{totalFiltered}</span>
        {totalFiltered < totalUnfiltered ? <span className="ml-1">(filtered from {totalUnfiltered})</span> : null}
      </div>
      <div className="flex items-center justify-between gap-3 sm:justify-end">
        <label className="flex items-center gap-1.5">
          <span>per page</span>
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="h-9 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:h-7 sm:text-xs"
          >
            {pageSizeOptions.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 sm:h-7 sm:w-7"
            disabled={safePage <= 1}
            onClick={() => onPageChange(Math.max(1, safePage - 1))}
            aria-label="previous page"
          >
            <ChevronLeft className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
          </Button>
          <span className="min-w-[4rem] text-center font-mono">
            {safePage} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 sm:h-7 sm:w-7"
            disabled={safePage >= totalPages}
            onClick={() => onPageChange(Math.min(totalPages, safePage + 1))}
            aria-label="next page"
          >
            <ChevronRight className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}
