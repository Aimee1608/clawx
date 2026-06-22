import { useState } from 'react'
import { RefreshCw, Trash2, MessageSquare, ExternalLink, Terminal } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useTmuxSessions } from '@/hooks/useTmuxSessions'
import { relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { copyToClipboard } from '@/lib/clipboard'
import { type TmuxSessionEntry } from '@/api'

export interface TmuxTabProps {
  /** Click handler to open the read-only messages drawer for a session. */
  onOpenSession: (entry: TmuxSessionEntry) => void
}

/**
 * Read-only "Tmux" tab. Lists active tmux sessions with view + kill +
 * per-row actions. Session creation lives in the CLI (`clawx solo`) and
 * the Lark `/new-tmux` command — not in this view.
 */
export function TmuxTab({ onOpenSession }: TmuxTabProps): JSX.Element {
  const tmux = useTmuxSessions()
  const [refreshing, setRefreshing] = useState(false)
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set())

  async function handleRefresh(): Promise<void> {
    if (refreshing) return
    setRefreshing(true)
    try {
      await tmux.refresh()
    } finally {
      setRefreshing(false)
    }
  }

  function setBusy(sid: string, busy: boolean): void {
    setBusyIds((prev) => {
      const next = new Set(prev)
      if (busy) next.add(sid)
      else next.delete(sid)
      return next
    })
  }

  async function handleKill(entry: TmuxSessionEntry): Promise<void> {
    if (busyIds.has(entry.sessionId)) return
    setBusy(entry.sessionId, true)
    try {
      const r = await tmux.kill(entry.sessionId)
      if (r.ok) toast.success(`✓ killed ${entry.sessionId}`)
      else toast.error(`kill failed: ${r.error}`)
    } finally {
      setBusy(entry.sessionId, false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Tmux Sessions</h2>
          <p className="text-sm text-muted-foreground">
            Long-running Claude/Codex REPL panes, shared by terminal + Lark + this UI.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
          <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
        </Button>
      </div>

      {tmux.loading ? (
        <Skeleton className="h-24 w-full" />
      ) : tmux.error ? (
        <Card className="border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {tmux.error}
        </Card>
      ) : tmux.sessions.length === 0 ? (
        <EmptyState
          icon={<Terminal className="h-12 w-12" />}
          title="No tmux sessions yet"
          description={
            <span>
              Start one from the CLI with{' '}
              <code className="rounded bg-muted px-1 py-0.5">clawx solo</code>, or DM the bot{' '}
              <code className="rounded bg-muted px-1 py-0.5">/new-tmux</code>.
            </span>
          }
        />
      ) : (
        <div className="grid gap-3">
          {tmux.sessions.map((s) => (
            <TmuxRow
              key={s.sessionId}
              entry={s}
              busy={busyIds.has(s.sessionId)}
              onOpen={() => onOpenSession(s)}
              onKill={() => handleKill(s)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Row ─────────────────────────────────────────────────────────────

function TmuxRow({
  entry,
  busy,
  onOpen,
  onKill,
}: {
  entry: TmuxSessionEntry
  busy: boolean
  onOpen: () => void
  onKill: () => void
}): JSX.Element {
  const attachCmd = `tmux attach -t ${entry.tmuxName}`
  const hasThread = !!entry.threadId
  return (
    <Card className={cn('p-4 transition-opacity', busy && 'opacity-50')}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <code className="text-sm font-medium">{entry.sessionId}</code>
            <Badge variant="outline" className="text-xs">
              {entry.agentKind ?? 'claude'}
            </Badge>
            {hasThread && (
              <Badge variant="outline" className="text-xs">
                Lark thread
              </Badge>
            )}
            {entry.label && (
              <Badge variant="secondary" className="text-xs">
                {entry.label}
              </Badge>
            )}
          </div>
          <div className="truncate font-mono text-xs text-muted-foreground">
            cwd: {entry.cwd}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {(entry.agentSessionId ?? entry.claudeUuid) && (
              <span>id: <code className="font-mono">{(entry.agentSessionId ?? entry.claudeUuid)!.slice(0, 8)}</code></span>
            )}
            <span>created: {relativeTime(Date.parse(entry.createdAt))}</span>
            {entry.lastTurnAt && (
              <span>last turn: {relativeTime(Date.parse(entry.lastTurnAt))}</span>
            )}
          </div>
          <div className="pt-1">
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={async () => {
                const ok = await copyToClipboard(attachCmd)
                if (ok) toast.success('tmux attach 命令已复制')
                else toast.error('复制失败，请手动选中文本')
              }}
              title="复制到剪贴板"
            >
              📋 <code className="font-mono">{attachCmd}</code>
            </button>
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
          <Button type="button" variant="default" size="sm" onClick={onOpen} disabled={busy}>
            <MessageSquare className="h-4 w-4" />
            <span className="ml-1 hidden sm:inline">打开会话</span>
          </Button>
          {hasThread && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={async () => {
                const ok = await copyToClipboard(entry.threadId ?? '')
                if (ok) toast.success('thread_id 已复制 — 在 Lark 搜索栏粘贴打开')
                else toast.error('复制失败，请手动选中文本')
              }}
              title="复制 thread_id"
            >
              <ExternalLink className="h-4 w-4" />
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onKill}
            disabled={busy}
            className="text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </Card>
  )
}
