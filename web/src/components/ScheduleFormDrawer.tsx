import { useEffect, useMemo, useState } from 'react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatLocalTime, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { api, type CreateScheduleBody, type CronPreviewResponse, type Schedule, type ScheduleAgentKind, type ScheduleKind, type TmuxSessionEntry } from '@/api'

export interface ScheduleFormDrawerProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** When set, the form runs in edit mode. When null/undefined → create mode. */
  editing: Schedule | null | undefined
  /** Default cwd to suggest for new prompt schedules — usually CLAUDE_CWD. */
  defaultCwd?: string
  onSubmit: (body: CreateScheduleBody, editingId: string | null) => Promise<void>
}

type TriggerType = 'recurring' | 'oneoff'

const CRON_PRESETS: Array<{ label: string; cron: string; description: string }> = [
  { label: 'Every weekday 09:00', cron: '0 9 * * 1-5', description: 'Mon-Fri morning' },
  { label: 'Every day 09:00', cron: '0 9 * * *', description: 'Daily morning' },
  { label: 'Every day 18:00', cron: '0 18 * * *', description: 'Daily evening' },
  { label: 'Mondays 10:00', cron: '0 10 * * 1', description: 'Weekly start-of-week' },
  { label: 'Every hour', cron: '0 * * * *', description: 'Top of every hour' },
  { label: 'Every 30 min', cron: '*/30 * * * *', description: 'Frequent check' },
]

const TIMEZONE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Server local time' },
  { value: 'UTC', label: 'UTC' },
  { value: 'Asia/Shanghai', label: 'Asia/Shanghai (UTC+8)' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo (UTC+9)' },
  { value: 'Asia/Singapore', label: 'Asia/Singapore (UTC+8)' },
  { value: 'Europe/London', label: 'Europe/London' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin' },
  { value: 'America/New_York', label: 'America/New_York' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles' },
]

const ONEOFF_PRESETS: Array<{ label: string; minutes: number }> = [
  { label: 'In 30 min', minutes: 30 },
  { label: 'In 1 hour', minutes: 60 },
  { label: 'In 3 hours', minutes: 180 },
  { label: 'Tomorrow 09:00', minutes: -1 }, // sentinel
]

const KIND_OPTIONS: Array<{ value: ScheduleKind; label: string; help: string }> = [
  {
    value: 'prompt',
    label: 'Prompt — run an agent with a prompt',
    help: 'Spawns the chosen agent one-shot in cwd, DM\'s the reply.',
  },
  {
    value: 'message',
    label: 'Message — send fixed text',
    help: 'Just DM\'s the payload as-is. Useful for reminders.',
  },
]

const AGENT_OPTIONS: Array<{ value: ScheduleAgentKind; label: string; help: string }> = [
  {
    value: 'claude',
    label: 'Claude — `claude --print`',
    help: 'Spawns a one-shot claude session in cwd, DM\'s the assistant\'s reply.',
  },
  {
    value: 'codex',
    label: 'Codex — `codex exec`',
    help: 'Runs a one-shot, ephemeral codex exec in cwd, DM\'s its answer. No tmux routing.',
  },
]

interface FormState {
  name: string
  triggerType: TriggerType
  cron: string
  /** Local-clock string in the `YYYY-MM-DDTHH:MM` shape produced by datetime-local inputs. */
  fireAtLocal: string
  timezone: string
  kind: ScheduleKind
  agentKind: ScheduleAgentKind
  payload: string
  cwd: string
  tmuxSessionId: string
  enabled: boolean
}

function emptyForm(defaultCwd?: string): FormState {
  return {
    name: '',
    triggerType: 'recurring',
    cron: '0 9 * * 1-5',
    fireAtLocal: defaultOneOffLocal(30),
    timezone: '',
    kind: 'prompt',
    agentKind: 'claude',
    payload: '',
    cwd: defaultCwd ?? '',
    tmuxSessionId: '',
    enabled: true,
  }
}

function fromSchedule(s: Schedule): FormState {
  const triggerType: TriggerType = s.fireAt ? 'oneoff' : 'recurring'
  return {
    name: s.name,
    triggerType,
    cron: s.cron ?? '0 9 * * 1-5',
    fireAtLocal: s.fireAt ? isoToLocalInput(s.fireAt) : defaultOneOffLocal(30),
    timezone: s.timezone ?? '',
    kind: s.kind,
    agentKind: s.agentKind ?? 'claude',
    payload: s.payload,
    cwd: s.cwd ?? '',
    tmuxSessionId: s.tmuxSessionId ?? '',
    enabled: s.enabled,
  }
}

/** Format a Date as the `YYYY-MM-DDTHH:MM` shape expected by `<input type="datetime-local">`,
 * using the user's local timezone (which is what datetime-local interprets). */
function dateToLocalInput(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function isoToLocalInput(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  return dateToLocalInput(new Date(t))
}

function defaultOneOffLocal(minutesFromNow: number): string {
  return dateToLocalInput(new Date(Date.now() + minutesFromNow * 60_000))
}

/** Convert a datetime-local string back to ISO. The browser interprets datetime-local
 * in the user's local timezone, which `new Date(s)` honors. */
function localInputToIso(local: string): string {
  if (!local) return ''
  const t = Date.parse(local)
  if (!Number.isFinite(t)) return ''
  return new Date(t).toISOString()
}

export function ScheduleFormDrawer({
  open,
  onOpenChange,
  editing,
  defaultCwd,
  onSubmit,
}: ScheduleFormDrawerProps): JSX.Element {
  const [form, setForm] = useState<FormState>(() => emptyForm(defaultCwd))
  const [saving, setSaving] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [preview, setPreview] = useState<CronPreviewResponse | null>(null)
  // Live list of tmux sessions for the "route through" picker. Reloaded
  // on drawer open so the user sees newly-created sessions without a
  // full reload.
  const [tmuxSessions, setTmuxSessions] = useState<TmuxSessionEntry[]>([])
  useEffect(() => {
    if (!open) return
    void api
      .listTmuxSessions()
      .then((r) => setTmuxSessions(r.sessions))
      .catch(() => setTmuxSessions([]))
  }, [open])

  // Reset form when the drawer opens or the editing target changes.
  useEffect(() => {
    if (!open) return
    setForm(editing ? fromSchedule(editing) : emptyForm(defaultCwd))
    setSubmitError(null)
    setPreview(null)
  }, [open, editing, defaultCwd])

  // Live preview — debounce to avoid hammering /api/cron/preview while typing.
  useEffect(() => {
    if (!open) return
    const handle = setTimeout(() => {
      const body =
        form.triggerType === 'recurring'
          ? { cron: form.cron, timezone: form.timezone || undefined }
          : { fireAt: localInputToIso(form.fireAtLocal) }
      void api
        .cronPreview(body)
        .then(setPreview)
        .catch(() => setPreview(null))
    }, 350)
    return () => clearTimeout(handle)
  }, [form.triggerType, form.cron, form.timezone, form.fireAtLocal, open])

  function patch<K extends keyof FormState>(k: K, v: FormState[K]): void {
    setForm((prev) => ({ ...prev, [k]: v }))
  }

  function applyOneOffPreset(p: typeof ONEOFF_PRESETS[number]): void {
    if (p.minutes < 0) {
      // "Tomorrow 09:00" — local 9am tomorrow.
      const d = new Date()
      d.setDate(d.getDate() + 1)
      d.setHours(9, 0, 0, 0)
      patch('fireAtLocal', dateToLocalInput(d))
    } else {
      patch('fireAtLocal', defaultOneOffLocal(p.minutes))
    }
  }

  async function handleSubmit(ev: React.FormEvent<HTMLFormElement>): Promise<void> {
    ev.preventDefault()
    setSubmitError(null)
    if (!form.name.trim()) {
      setSubmitError('Name is required')
      return
    }
    if (!form.payload.trim()) {
      setSubmitError('Payload is required')
      return
    }
    if (form.triggerType === 'oneoff') {
      const iso = localInputToIso(form.fireAtLocal)
      if (!iso) {
        setSubmitError('Pick a valid fire time')
        return
      }
      if (Date.parse(iso) <= Date.now()) {
        setSubmitError('Fire time must be in the future')
        return
      }
    }
    setSaving(true)
    try {
      const triggerFields: Pick<CreateScheduleBody, 'cron' | 'fireAt' | 'timezone'> =
        form.triggerType === 'recurring'
          ? { cron: form.cron.trim(), timezone: form.timezone || undefined }
          : { fireAt: localInputToIso(form.fireAtLocal) }
      // Codex prompts run standalone only — they can't route through a
      // claude tmux REPL, so we never send a tmuxSessionId for them.
      const isCodexPrompt = form.kind === 'prompt' && form.agentKind === 'codex'
      await onSubmit(
        {
          name: form.name.trim(),
          ...triggerFields,
          kind: form.kind,
          agentKind: form.kind === 'prompt' ? form.agentKind : undefined,
          payload: form.payload,
          cwd: form.cwd.trim() || undefined,
          tmuxSessionId:
            form.kind === 'prompt' && !isCodexPrompt && form.tmuxSessionId.trim()
              ? form.tmuxSessionId.trim()
              : undefined,
          enabled: form.enabled,
        },
        editing?.id ?? null,
      )
      onOpenChange(false)
    } catch (err: any) {
      setSubmitError(err?.message ?? String(err))
    } finally {
      setSaving(false)
    }
  }

  const isEdit = Boolean(editing)
  const kindMeta = KIND_OPTIONS.find((o) => o.value === form.kind)!
  const agentMeta = AGENT_OPTIONS.find((o) => o.value === form.agentKind)!
  const isCodexPrompt = form.kind === 'prompt' && form.agentKind === 'codex'

  const oneOffSummary = useMemo(() => {
    if (form.triggerType !== 'oneoff') return null
    const iso = localInputToIso(form.fireAtLocal)
    if (!iso) return null
    const t = Date.parse(iso)
    if (!Number.isFinite(t)) return null
    return { iso, t }
  }, [form.triggerType, form.fireAtLocal])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="sticky top-0 z-10 border-b bg-background/95 px-4 py-3 backdrop-blur sm:px-6">
          <SheetTitle>{isEdit ? 'Edit schedule' : 'New schedule'}</SheetTitle>
          <SheetDescription>
            {isEdit ? 'Update fields and Save.' : 'Configure when and what claude should run.'}
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          <div className="space-y-5">
            {/* name */}
            <div className="grid gap-1.5">
              <Label htmlFor="schedule-name">Name</Label>
              <Input
                id="schedule-name"
                value={form.name}
                onChange={(e) => patch('name', e.target.value)}
                placeholder="Daily standup brief"
                required
              />
            </div>

            {/* kind */}
            <div className="grid gap-1.5">
              <Label htmlFor="schedule-kind">Kind</Label>
              <select
                id="schedule-kind"
                value={form.kind}
                onChange={(e) => patch('kind', e.target.value as ScheduleKind)}
                className="h-9 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {KIND_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{kindMeta.help}</p>
            </div>

            {/* agent (prompt only) */}
            {form.kind === 'prompt' ? (
              <div className="grid gap-1.5">
                <Label htmlFor="schedule-agent">Agent</Label>
                <select
                  id="schedule-agent"
                  value={form.agentKind}
                  onChange={(e) => patch('agentKind', e.target.value as ScheduleAgentKind)}
                  className="h-9 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {AGENT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">{agentMeta.help}</p>
              </div>
            ) : null}

            {/* trigger */}
            <div className="grid gap-2">
              <Label>Trigger</Label>
              <Tabs
                value={form.triggerType}
                onValueChange={(v) => patch('triggerType', v as TriggerType)}
              >
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="recurring">Recurring (cron)</TabsTrigger>
                  <TabsTrigger value="oneoff">One-off</TabsTrigger>
                </TabsList>

                <TabsContent value="recurring" className="space-y-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="schedule-cron">Cron</Label>
                    <Input
                      id="schedule-cron"
                      value={form.cron}
                      onChange={(e) => patch('cron', e.target.value)}
                      placeholder="0 9 * * 1-5"
                      className={cn(
                        'font-mono',
                        preview && !preview.valid && 'border-destructive focus-visible:ring-destructive',
                      )}
                    />
                    <div className="flex flex-wrap gap-1.5">
                      {CRON_PRESETS.map((p) => (
                        <button
                          key={p.cron}
                          type="button"
                          onClick={() => patch('cron', p.cron)}
                          className={cn(
                            'rounded-md border px-2 py-1 text-[11px] transition-colors',
                            form.cron === p.cron
                              ? 'border-primary bg-primary/10 text-foreground'
                              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                          )}
                          title={p.description}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="schedule-tz">Timezone <span className="font-normal text-muted-foreground">(optional)</span></Label>
                    <select
                      id="schedule-tz"
                      value={form.timezone}
                      onChange={(e) => patch('timezone', e.target.value)}
                      className="h-9 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      {TIMEZONE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground">
                      `0 9 * * 1-5` in `Asia/Shanghai` fires at 9am Beijing regardless of where the bot runs.
                    </p>
                  </div>
                </TabsContent>

                <TabsContent value="oneoff" className="space-y-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="schedule-fireat">Fire at</Label>
                    <Input
                      id="schedule-fireat"
                      type="datetime-local"
                      value={form.fireAtLocal}
                      onChange={(e) => patch('fireAtLocal', e.target.value)}
                      className="font-mono"
                    />
                    <div className="flex flex-wrap gap-1.5">
                      {ONEOFF_PRESETS.map((p) => (
                        <button
                          key={p.label}
                          type="button"
                          onClick={() => applyOneOffPreset(p)}
                          className="rounded-md border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                    {oneOffSummary ? (
                      <p className="text-xs text-muted-foreground">
                        Will fire {relativeTime(oneOffSummary.t)} at{' '}
                        <span className="font-mono">{formatLocalTime(oneOffSummary.t)}</span>. Auto-disables after firing.
                      </p>
                    ) : null}
                  </div>
                </TabsContent>
              </Tabs>
              <PreviewRender preview={preview} triggerType={form.triggerType} />
            </div>

            {/* payload */}
            <div className="grid gap-1.5">
              <Label htmlFor="schedule-payload">
                {form.kind === 'prompt' ? 'Prompt for claude' : 'Message text'}
              </Label>
              <textarea
                id="schedule-payload"
                value={form.payload}
                onChange={(e) => patch('payload', e.target.value)}
                placeholder={
                  form.kind === 'prompt'
                    ? '请总结今日 git log --since=yesterday 里我相关的 commit'
                    : '🔔 别忘了今天的 1-on-1'
                }
                rows={5}
                className="rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>

            {/* cwd + tmux routing (prompt only) */}
            {form.kind === 'prompt' ? (
              <>
                {/* tmux routing is claude-only — codex prompts always run
                    standalone (no claude REPL to send-keys into). */}
                {!isCodexPrompt ? (
                  <div className="grid gap-1.5">
                    <Label htmlFor="schedule-tmux">
                      Route through tmux session{' '}
                      <span className="font-normal text-muted-foreground">(optional)</span>
                    </Label>
                    <select
                      id="schedule-tmux"
                      value={form.tmuxSessionId}
                      onChange={(e) => patch('tmuxSessionId', e.target.value)}
                      className="h-9 rounded-md border border-input bg-transparent px-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <option value="">— None (one-shot claude --print, reply DM'd) —</option>
                      {tmuxSessions.map((s) => (
                        <option key={s.sessionId} value={s.sessionId}>
                          {s.sessionId} · {s.cwd}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground">
                      When set, the payload is sent into that session's claude REPL via{' '}
                      <span className="font-mono">send-keys</span>; the reply surfaces in the
                      session's bound Lark thread (no DM). Reuses claude's existing context.
                    </p>
                  </div>
                ) : null}

                <div className="grid gap-1.5">
                  <Label htmlFor="schedule-cwd">
                    CWD <span className="font-normal text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    id="schedule-cwd"
                    value={form.cwd}
                    onChange={(e) => patch('cwd', e.target.value)}
                    placeholder={defaultCwd ?? '/path/to/project'}
                    className="font-mono text-xs"
                    disabled={!isCodexPrompt && !!form.tmuxSessionId}
                  />
                  <p className="text-xs text-muted-foreground">
                    {!isCodexPrompt && form.tmuxSessionId
                      ? "Ignored when routing through a tmux session — the session's own cwd applies."
                      : `Leave blank to use the bot's default (${defaultCwd ?? 'CLAUDE_CWD'}).`}
                  </p>
                </div>
              </>
            ) : null}

            {/* enabled */}
            <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-3">
              <div>
                <div className="text-sm font-medium">Enabled</div>
                <div className="text-xs text-muted-foreground">
                  When off, the schedule is paused — won't fire on cron, but `Run now` still works.
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={form.enabled}
                onClick={() => patch('enabled', !form.enabled)}
                className={cn(
                  'relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors',
                  form.enabled ? 'bg-primary' : 'bg-muted',
                )}
              >
                <span
                  className={cn(
                    'inline-block h-5 w-5 transform rounded-full bg-background shadow transition-transform',
                    form.enabled ? 'translate-x-4' : 'translate-x-0.5',
                  )}
                />
              </button>
            </div>

            {submitError ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                {submitError}
              </div>
            ) : null}
          </div>

          <SheetFooter className="!mt-8 gap-2 sm:space-x-0">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create'}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

function PreviewRender({
  preview,
  triggerType,
}: {
  preview: CronPreviewResponse | null
  triggerType: TriggerType
}): JSX.Element | null {
  if (!preview) return null
  if (!preview.valid) {
    return (
      <p className="text-xs text-destructive">
        {triggerType === 'recurring' ? 'Invalid cron' : 'Invalid fire time'}: {preview.error ?? 'parse error'}
      </p>
    )
  }
  if (!preview.nextRuns || preview.nextRuns.length === 0) {
    return <p className="text-xs text-muted-foreground">Next runs: (none)</p>
  }
  return (
    <div className="text-xs text-muted-foreground">
      <div>{triggerType === 'recurring' ? 'Next runs:' : 'Will fire:'}</div>
      <ul className="mt-1 list-inside list-disc space-y-0.5 font-mono">
        {preview.nextRuns.map((iso) => (
          <li key={iso} title={iso}>
            {formatLocalTime(Date.parse(iso))}{' '}
            <span className="text-muted-foreground/70">({relativeTime(Date.parse(iso))})</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
