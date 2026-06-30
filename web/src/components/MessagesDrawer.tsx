import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Copy,
  Loader2,
  MessageSquareDashed,
  Send,
  Terminal,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { RawPaneViewer } from './RawPaneViewer'
import { copyToClipboard } from '@/lib/clipboard'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { MarkdownText } from './MarkdownText'
import { formatLocalTime, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { UiMessage } from '@/api'

export interface MessagesDrawerProps {
  open: boolean
  /** Subtitle below the title — caller shapes the displayed metadata. */
  subtitle?: React.ReactNode
  /** The agent/claude session id being viewed (= the jsonl uuid). Shown as a
   * copyable chip under the title, always — even on a deep-linked open where
   * there's no cached subtitle. */
  sessionId?: string | null
  messages: UiMessage[]
  loading: boolean
  error: string | null
  /** Optional info banner (e.g. "session jsonl not found yet"). */
  note: string | null
  onOpenChange: (v: boolean) => void
  /** When provided, the drawer renders a composer at the bottom that
   * lets the user inject a new turn into this session. Returns a
   * promise; resolves on success, rejects with a user-facing error on
   * failure. */
  onSend?: (prompt: string) => Promise<void>
  /** Jsonl mtime in ms-since-epoch and server time, used to flag
   * "session may still be running" when the gap is small. */
  lastModifiedMs?: number | null
  nowMs?: number | null
  /** When set to a clawx tmux session id, the drawer offers a "raw
   * terminal" toggle (live capture-pane snapshot). Independent from
   * the chat bubble view — toggling just swaps the body. */
  tmuxSid?: string | null
  /** Full `tmux attach -t <name>` command for the drawer header.
   * Renders as a copy-able code chip so the user can hop into the
   * same REPL from a terminal. Only meaningful when tmuxSid is set. */
  tmuxAttachCmd?: string | null
  /** Lark thread id (omt_*) bound to this tmux session. Shown next to
   * the attach command so the user can paste it into Lark's search bar
   * to jump straight to the conversation. */
  tmuxThreadId?: string | null
}

/** Recency threshold for the "session may be running" warning. */
const ACTIVE_WINDOW_MS = 30_000

/**
 * Conversation drawer rendering user/assistant turns as iMessage-style
 * bubbles (user right + accent, assistant left + neutral, error left + red).
 *
 * Layout:
 *   - mobile (<sm): full-screen modal, sticky back-arrow header, scrollable
 *     bubbles below. Mimics native messaging app navigation.
 *   - desktop (sm+): right-side sheet at sm:max-w-2xl (≈672px), same header
 *     just without the back arrow.
 *
 * Pure presentational — no fetch, polling owned by parent's hook.
 */
export function MessagesDrawer({
  open,
  subtitle,
  sessionId,
  messages,
  loading,
  error,
  note,
  onOpenChange,
  onSend,
  lastModifiedMs,
  nowMs,
  tmuxSid,
  tmuxAttachCmd,
  tmuxThreadId,
}: MessagesDrawerProps): JSX.Element {
  // 'chat' = bubble view (jsonl-driven); 'raw' = capture-pane mirror.
  // Only meaningful when tmuxSid is set; the toggle is hidden otherwise.
  const [view, setView] = useState<'chat' | 'raw'>('chat')
  // Reset to chat view when the drawer's target changes (open/close,
  // different session) — otherwise the previous tmux's raw view would
  // briefly leak into the new drawer body.
  useEffect(() => {
    setView('chat')
  }, [tmuxSid, open])
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        // 2/3 viewport width on desktop; full width on mobile.
        className="flex w-full flex-col gap-0 p-0 sm:w-2/3 sm:max-w-none"
        // Hide the SheetContent's built-in close button — we render our own
        // back-arrow inside the sticky header so it's reachable on phones.
        hideCloseButton
      >
        {/* sticky top bar */}
        <SheetHeader className="sticky top-0 z-10 flex-shrink-0 space-y-1 border-b bg-background/95 px-4 py-3 backdrop-blur sm:px-6">
          <div className="flex items-start gap-3">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground sm:hidden"
              aria-label="back"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-left">Session Messages</SheetTitle>
              {subtitle ? (
                <SheetDescription className="mt-0.5 truncate text-left">{subtitle}</SheetDescription>
              ) : null}
              {sessionId ? (
                <button
                  type="button"
                  onClick={() => {
                    void copyToClipboard(sessionId).then((ok) =>
                      toast[ok ? 'success' : 'error'](ok ? '已复制 session id' : '复制失败'),
                    )
                  }}
                  className="group mt-1 inline-flex max-w-full items-center gap-1 rounded border border-input bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:border-primary hover:text-primary"
                  title="点击复制 session id(jsonl uuid)"
                >
                  <span className="truncate">session: {sessionId}</span>
                  <Copy className="h-3 w-3 shrink-0" />
                </button>
              ) : null}
            </div>
            {tmuxSid ? (
              <button
                type="button"
                onClick={() => setView((v) => (v === 'chat' ? 'raw' : 'chat'))}
                className={cn(
                  'hidden h-8 shrink-0 items-center gap-1 rounded-md border px-2 text-xs sm:flex',
                  view === 'raw'
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-input text-muted-foreground hover:text-foreground',
                )}
                aria-label="toggle raw terminal view"
                title="Toggle raw tmux pane (live capture-pane snapshot)"
              >
                <Terminal className="h-3.5 w-3.5" />
                {view === 'raw' ? 'Chat' : 'Raw'}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground sm:flex"
              aria-label="close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {tmuxSid && tmuxAttachCmd ? (
            <TmuxAttachBar attachCmd={tmuxAttachCmd} threadId={tmuxThreadId ?? null} />
          ) : null}
        </SheetHeader>

        {/* scrollable body — chat bubbles OR raw tmux pane */}
        {tmuxSid && view === 'raw' ? (
          <div className="flex-1 overflow-hidden">
            <RawPaneViewer sid={tmuxSid} />
          </div>
        ) : (
          <ScrollableBody
            loading={loading}
            error={error}
            note={note}
            messages={messages}
          />
        )}

        {/* composer (only when caller wires onSend) */}
        {onSend ? (
          <Composer
            onSend={onSend}
            lastModifiedMs={lastModifiedMs ?? null}
            nowMs={nowMs ?? null}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

// ── Tmux attach bar ────────────────────────────────────────────────

/**
 * Renders the `tmux attach -t <name>` command (and optionally the
 * Lark thread id) right under the drawer header. Each chip is
 * click-to-copy. Lets the user jump from "viewing the session in the
 * browser" to "live REPL in their terminal" in one paste.
 */
function TmuxAttachBar({
  attachCmd,
  threadId,
}: {
  attachCmd: string
  threadId: string | null
}): JSX.Element {
  async function copy(value: string, label: string): Promise<void> {
    const ok = await copyToClipboard(value)
    if (ok) toast.success(`已复制 ${label}`)
    else toast.error('复制失败，请手动选中文本')
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-dashed pt-2 text-xs">
      <span className="text-muted-foreground">在终端 attach:</span>
      <button
        type="button"
        onClick={() => void copy(attachCmd, 'tmux 命令')}
        className={cn(
          'group inline-flex max-w-full items-center gap-1.5 rounded-md border border-input bg-muted/40 px-2 py-1',
          'font-mono text-xs hover:border-primary hover:bg-primary/5',
        )}
        title="点击复制"
      >
        <span className="truncate">{attachCmd}</span>
        <Copy className="h-3 w-3 shrink-0 text-muted-foreground group-hover:text-primary" />
      </button>
      {threadId ? (
        <button
          type="button"
          onClick={() => void copy(threadId, 'thread_id')}
          className="group inline-flex items-center gap-1.5 rounded-md border border-input bg-muted/40 px-2 py-1 font-mono text-xs hover:border-primary hover:bg-primary/5"
          title="点击复制 thread_id，到 Lark 搜索栏粘贴可跳转到话题"
        >
          <span className="text-muted-foreground">thread:</span>
          <span className="truncate">{threadId}</span>
          <Copy className="h-3 w-3 shrink-0 text-muted-foreground group-hover:text-primary" />
        </button>
      ) : null}
    </div>
  )
}

// ── Composer ───────────────────────────────────────────────────────

interface ComposerProps {
  onSend: (prompt: string) => Promise<void>
  lastModifiedMs: number | null
  nowMs: number | null
}

function Composer({ onSend, lastModifiedMs, nowMs }: ComposerProps): JSX.Element {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  // Heuristic: jsonl modified within the last 30s → another claude
  // process may still be writing to this session. We DON'T block the
  // send (the user knows what they're doing), but we surface the risk
  // and rename the button to "Send anyway".
  const maybeRunning =
    typeof lastModifiedMs === 'number' &&
    typeof nowMs === 'number' &&
    nowMs - lastModifiedMs < ACTIVE_WINDOW_MS

  async function submit(): Promise<void> {
    const prompt = text.trim()
    if (!prompt || sending) return
    setSending(true)
    setLocalError(null)
    try {
      await onSend(prompt)
      setText('')
      taRef.current?.focus()
    } catch (err: any) {
      setLocalError(err?.message ?? String(err))
    } finally {
      setSending(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    // Cmd/Ctrl+Enter to send; plain Enter inserts a newline so users
    // can compose multi-line prompts naturally.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div className="flex-shrink-0 border-t bg-background/95 px-4 py-3 backdrop-blur sm:px-6">
      {maybeRunning ? (
        <div className="mb-2 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            session 最近 30 秒内有写入，可能仍在另一个 claude 进程里运行。
            发送会把消息插入到对方的对话流。
          </div>
        </div>
      ) : null}
      {localError ? (
        <div className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {localError}
        </div>
      ) : null}
      <div className="flex items-end gap-2">
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={sending}
          placeholder="把消息接到这个 session 里… (⌘/Ctrl+Enter 发送)"
          rows={2}
          className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="reply text"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={sending || !text.trim()}
          className={cn(
            'inline-flex h-10 items-center gap-1.5 rounded-md px-3 text-sm font-medium shadow-sm transition-colors',
            'bg-primary text-primary-foreground hover:bg-primary/90',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
          aria-label={maybeRunning ? 'send anyway' : 'send'}
        >
          {sending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          <span className="hidden sm:inline">{maybeRunning ? 'Send anyway' : 'Send'}</span>
        </button>
      </div>
    </div>
  )
}

// ── Scrollable body with floating jump-to-top/bottom controls ──────

const SCROLL_THRESHOLD_PX = 80 // hide arrow if within this many px of edge

function ScrollableBody({
  loading,
  error,
  note,
  messages,
}: {
  loading: boolean
  error: string | null
  note: string | null
  messages: UiMessage[]
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [canScrollUp, setCanScrollUp] = useState(false)
  const [canScrollDown, setCanScrollDown] = useState(false)

  // Re-evaluate visibility when messages change (new turn arrives) or
  // on every scroll event from the body.
  function refresh(): void {
    const el = scrollRef.current
    if (!el) {
      setCanScrollUp(false)
      setCanScrollDown(false)
      return
    }
    const { scrollTop, scrollHeight, clientHeight } = el
    setCanScrollUp(scrollTop > SCROLL_THRESHOLD_PX)
    setCanScrollDown(scrollTop + clientHeight < scrollHeight - SCROLL_THRESHOLD_PX)
  }

  useEffect(() => {
    // Recompute after the DOM has the new message rendered.
    const id = requestAnimationFrame(refresh)
    return () => cancelAnimationFrame(id)
  }, [messages.length, loading, error])

  function jumpTo(target: 'top' | 'bottom'): void {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({
      top: target === 'top' ? 0 : el.scrollHeight,
      behavior: 'smooth',
    })
  }

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={refresh}
        className="h-full overflow-y-auto px-4 py-4 sm:px-6"
      >
        {loading ? (
          <SkeletonBubbles />
        ) : error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        ) : messages.length === 0 ? (
          <EmptyState
            icon={<MessageSquareDashed className="h-12 w-12" />}
            title="No messages yet"
            description={note ?? 'send a DM to the bot to start a conversation'}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((m) => (
              <Bubble key={m.uuid || m.timestamp} message={m} />
            ))}
          </div>
        )}
      </div>

      {/* Floating jump buttons — fade in when there's something to scroll
          to in that direction. Stacked vertically on the right edge. */}
      <div className="pointer-events-none absolute bottom-4 right-3 flex flex-col gap-2 sm:right-4">
        <JumpButton
          direction="up"
          visible={canScrollUp}
          onClick={() => jumpTo('top')}
        />
        <JumpButton
          direction="down"
          visible={canScrollDown}
          onClick={() => jumpTo('bottom')}
        />
      </div>
    </div>
  )
}

function JumpButton({
  direction,
  visible,
  onClick,
}: {
  direction: 'up' | 'down'
  visible: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={direction === 'up' ? 'scroll to top' : 'scroll to bottom'}
      className={cn(
        'flex h-10 w-10 items-center justify-center rounded-full border bg-background/95 text-foreground/80 shadow-md backdrop-blur',
        'transition-all duration-200 hover:bg-muted hover:text-foreground',
        visible
          ? 'pointer-events-auto opacity-100'
          : 'pointer-events-none opacity-0 translate-y-1',
      )}
    >
      {direction === 'up' ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
    </button>
  )
}

// ── Bubble ─────────────────────────────────────────────────────

function Bubble({ message: m }: { message: UiMessage }): JSX.Element {
  const isUser = m.role === 'user'
  const ts = m.timestamp ? Date.parse(m.timestamp) : null
  const tsLabel = ts ? relativeTime(ts) : ''
  const tsTooltip = ts ? formatLocalTime(ts) : ''

  return (
    <div className={cn('flex min-w-0 gap-2', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          // `min-w-0` lets the flex column actually shrink below its
          // intrinsic content width — without it, an unbreakable long
          // run (URL, base64, long path) keeps the bubble wider than
          // the drawer and overflows horizontally with no scrollbar.
          'flex min-w-0 max-w-[85%] flex-col gap-1 sm:max-w-[75%]',
          isUser ? 'items-end' : 'items-start',
        )}
      >
        <div
          className={cn(
            // overflow-wrap:anywhere is the modern fix that lets the
            // browser break at any code point when needed (URLs etc.),
            // while still preferring word boundaries when possible.
            'min-w-0 max-w-full rounded-2xl px-3.5 py-2.5 text-sm [overflow-wrap:anywhere]',
            // user / error: keep plain text + whitespace preserved.
            // Assistant: render markdown so headings, lists, code blocks
            // and tables look like they do in the live chat tab.
            isUser || m.isError ? 'whitespace-pre-wrap' : null,
            isUser
              ? 'rounded-br-sm bg-primary text-primary-foreground'
              : m.isError
              ? 'rounded-bl-sm border border-destructive/30 bg-destructive/10 text-destructive'
              : 'rounded-bl-sm bg-muted text-foreground',
          )}
        >
          {isUser || m.isError ? m.text : <MarkdownText text={m.text} />}
        </div>
        <div className="flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground">
          <span className="uppercase tracking-wider">{m.role}</span>
          {m.isError ? <span>· error</span> : null}
          {tsLabel ? (
            <span title={tsTooltip}>· {tsLabel}</span>
          ) : null}
        </div>
      </div>
    </div>
  )
}

// ── Loading state ──────────────────────────────────────────────

function SkeletonBubbles(): JSX.Element {
  // Two pairs of user / assistant bubbles to suggest the shape.
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Skeleton className="h-9 w-2/3 rounded-2xl rounded-br-sm" />
      </div>
      <div className="flex justify-start">
        <Skeleton className="h-12 w-3/4 rounded-2xl rounded-bl-sm" />
      </div>
      <div className="flex justify-end">
        <Skeleton className="h-9 w-1/2 rounded-2xl rounded-br-sm" />
      </div>
      <div className="flex justify-start">
        <Skeleton className="h-16 w-4/5 rounded-2xl rounded-bl-sm" />
      </div>
    </div>
  )
}
