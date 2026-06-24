import * as React from 'react'
import { Terminal, Trash2, Copy, MessageSquare, ExternalLink, Send } from 'lucide-react'
import { toast } from 'sonner'

import { Card, CardContent, CardFooter } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { relativeTime } from '@/lib/format'
import { copyToClipboard } from '@/lib/clipboard'
import { api, type TmuxSessionEntry, type TmuxSessionState } from '@/api'

/** Status visuals — a compact dot + label the card shows in both the status
 * board and the project-grouped view (where the column no longer conveys it). */
const STATUS_META: Record<TmuxSessionState['status'], { label: string; dot: string; text: string }> = {
  working: { label: '工作中', dot: 'bg-emerald-500 animate-pulse', text: 'text-emerald-600 dark:text-emerald-400' },
  stuck: { label: '卡住', dot: 'bg-red-500 animate-pulse', text: 'text-red-600 dark:text-red-400' },
  idle: { label: '空闲', dot: 'bg-zinc-400', text: 'text-muted-foreground' },
  offline: { label: '离线', dot: 'bg-zinc-300', text: 'text-muted-foreground/70' },
}

function basename(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] || cwd || '—'
}

export interface SessionCardProps {
  entry: TmuxSessionEntry
  state?: TmuxSessionState
  /** Open the messages drawer (full transcript + send + Raw pane toggle). */
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
  const [sendOpen, setSendOpen] = React.useState(false)
  const [draft, setDraft] = React.useState('')
  const [sending, setSending] = React.useState(false)

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

  async function handleSend(): Promise<void> {
    const text = draft.trim()
    if (!text) return
    setSending(true)
    try {
      await api.sendToTmuxSession(entry.sessionId, text)
      toast.success('已发送')
      setDraft('')
      setSendOpen(false)
    } catch (err: any) {
      toast.error(`发送失败: ${err?.message ?? String(err)}`)
    } finally {
      setSending(false)
    }
  }

  return (
    <Card className="flex flex-col transition-colors hover:border-primary/40">
      <CardContent className="flex-1 space-y-2 pt-3">
        <div className="flex items-center justify-between gap-2">
          <span className={`flex items-center gap-1.5 text-[11px] font-medium ${meta.text}`}>
            <span className={`inline-block h-2 w-2 rounded-full ${meta.dot}`} />
            {meta.label}
            {state && state.repl !== 'idle' && state.repl !== 'dead' ? (
              <span className="font-mono opacity-60">· {state.repl}</span>
            ) : null}
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

        <div className="text-[11px] text-muted-foreground">
          <span title={new Date(lastActivity).toLocaleString()}>活动 {relativeTime(lastActivity)}</span>
        </div>

        {sendOpen ? (
          <div className="space-y-1.5">
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void handleSend()
                if (e.key === 'Escape') setSendOpen(false)
              }}
              rows={2}
              placeholder="发条消息给这个会话…(⌘/Ctrl+Enter 发送)"
              className="w-full resize-none rounded border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
            />
            <div className="flex justify-end gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setSendOpen(false)} className="h-6 px-2 text-xs">
                取消
              </Button>
              <Button
                size="sm"
                variant="default"
                onClick={() => void handleSend()}
                disabled={sending || !draft.trim()}
                className="h-6 gap-1 px-2 text-xs"
              >
                <Send className="h-3 w-3" />
                {sending ? '…' : '发送'}
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>

      <CardFooter className="flex flex-wrap gap-1.5 border-t pt-2.5">
        <Button size="sm" variant="default" onClick={() => onOpen(entry)} className="h-7 gap-1 px-2 text-xs">
          <MessageSquare className="h-3.5 w-3.5" />
          打开
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setSendOpen((v) => !v)}
          className="h-7 gap-1 px-2 text-xs"
        >
          <Send className="h-3.5 w-3.5" />
          发送
        </Button>
        <Button size="sm" variant="outline" onClick={handleCopyAttach} className="h-7 gap-1 px-2 text-xs" title={attachCmd}>
          <Copy className="h-3.5 w-3.5" />
          attach
        </Button>
        {entry.chatId ? (
          <a
            href={`https://applink.feishu.cn/client/chat/open?openChatId=${entry.chatId}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs hover:bg-muted"
            title="打开会话所在的飞书群(applink 仅支持到群)"
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
