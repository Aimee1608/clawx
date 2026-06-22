import { Settings2, Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatDuration } from '@/lib/format'
import type { StatusResponse } from '@/api'

export interface TopBarProps {
  /** Live status snapshot. Null until first fetch resolves. */
  status: StatusResponse | null
  /** Email (or null in WS-only setups) shown beside the status pill. */
  user: string | null
  onOpenConfig: () => void
}

/**
 * Sticky header rendering brand mark + live status + user identity + a
 * gear that opens the Config drawer. Pure presentational — receives all
 * data via props.
 */
export function TopBar({ status, user, onOpenConfig }: TopBarProps): JSX.Element {
  return (
    <header className="sticky top-0 z-30 w-full border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-screen-2xl items-center justify-between gap-2 px-4 sm:px-6">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Zap className="h-4 w-4" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold">clawx</span>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">local control plane</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {user ? (
            <span className="hidden font-mono text-xs text-muted-foreground md:inline">{user}</span>
          ) : null}
          {status ? (
            <>
              <Badge variant={status.mode === 'hub' ? 'default' : 'secondary'}>{status.mode}</Badge>
              <span className="hidden font-mono text-xs text-muted-foreground sm:inline">
                {status.instanceId.slice(0, 8)} · {formatDuration(status.uptimeSec)} · pid {status.pid}
              </span>
            </>
          ) : (
            <Badge variant="outline">loading…</Badge>
          )}
          <Button variant="ghost" size="icon" onClick={onOpenConfig} aria-label="Configure">
            <Settings2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </header>
  )
}
