import * as React from 'react'
import { Terminal, Trash2, Copy, MessageSquare, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'

import { Card, CardContent, CardFooter } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { relativeTime } from '@/lib/format'
import { copyToClipboard } from '@/lib/clipboard'
import type { TmuxSessionEntry, TmuxSessionState } from '@/api'

/** Visuals per coarse status. `variant` drives the Badge color; `dot` is the
 * small leading indicator. Unknown/missing state falls back to idle. */
const STATUS_META: Record<
  TmuxSessionState['status'],
  { label: string; variant: 'success' | 'secondary' | 'destructive' | 'outline'; dot: string }
> = {
  working: { label: '工作中', variant: 'success', dot: 'bg-emerald-500 animate-pulse' },
  idle: { label: '空闲', variant: 'secondary', dot: 'bg-zinc-400' },
  stuck: { label: '卡住', variant: 'destructive', dot: 'bg-red-500 animate-pulse' },
  offline: { label: '离线', variant: 'outline', dot: 'bg-zinc-300' },
}

function basename(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] || cwd || '—'
}

export interface SessionCardProps {
  entry: TmuxSessionEntry
  state?: TmuxSessionState
  /** Open the messages drawer (full transcript + send box) for this session. */
  onOpen: (e: TmuxSessionEntry) => void
  /** Kill the session; resolves to ok/error so the card can toast. */
  onKill: (sid: string) => Promise<{ ok: true } | { ok: false; error: string }>
}

export function SessionCard({ entry, state, onOpen, onKill }: SessionCardProps): JSX.Element {
  const status = state?.status ?? 'idle'
  const meta = STATUS_META[status]
  const agent = entry.agentKind ?? 'claude'
  const title = entry.label?.trim() || basename(entry.cwd)
  const lastActivity = entry.lastTurnAt ? Date.parse(entry.lastTurnAt) : Date.parse(entry.createdAt)
  const attachCmd = `tmux attach -t ${entry.tmuxName}`

  const [killing, setKilling] = React.useState(false)

  async function handleKill(): Promise<void> {
    if (!window.confirm(`确认关闭会话「${title}」?`)) return
    setKilling(true)
    const r = await onKill(entry.sessionId)
    setKilling(false)
    if (r.ok) toast.success(`✓ 已关闭 ${entry.sessionId}`)
    else toast.error(`关闭失败: ${r.error}`)
  }

  async function handleCopyAttach(): Promise<void> {
    const ok = await copyToClipboard(attachCmd)
    toast[ok ? 'success' : 'error'](ok ? '已复制 attach 命令' : '复制失败')
  }

  return (
    <Card className="flex flex-col transition-colors hover:border-primary/40">
      <CardContent className="flex-1 space-y-2 pt-4">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium">
            <span className={`inline-block h-2 w-2 rounded-full ${meta.dot}`} />
            <Badge variant={meta.variant}>{meta.label}</Badge>
          </span>
          <span className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
            <Terminal className="h-3 w-3" />
            {agent}
          </span>
        </div>

        <button
          onClick={() => onOpen(entry)}
          className="block w-full truncate text-left text-sm font-semibold hover:text-primary"
          title={title}
        >
          {title}
        </button>

        <div className="truncate font-mono text-[11px] text-muted-foreground" title={entry.cwd}>
          {entry.cwd}
        </div>

        {state?.preview ? (
          <p
            className="line-clamp-2 rounded bg-muted/50 px-2 py-1 text-[11px] leading-snug text-muted-foreground"
            title={state.preview}
          >
            {state.preview}
          </p>
        ) : null}

        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span title={new Date(lastActivity).toLocaleString()}>
            活动 {relativeTime(lastActivity)}
          </span>
          {state && state.repl !== 'idle' && state.repl !== 'dead' ? (
            <span className="font-mono opacity-70">· {state.repl}</span>
          ) : null}
        </div>
      </CardContent>

      <CardFooter className="flex flex-wrap gap-1.5 border-t pt-3">
        <Button size="sm" variant="default" onClick={() => onOpen(entry)} className="h-7 gap-1 px-2 text-xs">
          <MessageSquare className="h-3.5 w-3.5" />
          打开
        </Button>
        <Button size="sm" variant="outline" onClick={handleCopyAttach} className="h-7 gap-1 px-2 text-xs">
          <Copy className="h-3.5 w-3.5" />
          attach
        </Button>
        {entry.chatId ? (
          <a
            href={`https://applink.feishu.cn/client/chat/open?openChatId=${entry.chatId}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs hover:bg-muted"
            title="打开会话所在的飞书群(飞书 applink 仅支持到群,无法精确跳到话题)"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            群
          </a>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          onClick={handleKill}
          disabled={killing}
          className="ml-auto h-7 gap-1 px-2 text-xs text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {killing ? '…' : 'kill'}
        </Button>
      </CardFooter>
    </Card>
  )
}
