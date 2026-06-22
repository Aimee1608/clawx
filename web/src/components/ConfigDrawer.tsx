import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import type { ConfigResponse } from '@/api'

export const CONFIG_FIELDS: Array<{ key: keyof ConfigResponse['config']; label: string; hint: string; secret?: boolean }> = [
  { key: 'claudeCwd', label: 'CLAUDE_CWD', hint: 'working directory for claude subprocess' },
  { key: 'claudeCmd', label: 'CLAUDE_CMD', hint: 'binary name (default: claude)' },
  { key: 'larkAppId', label: 'LARK_APP_ID', hint: 'Feishu app id' },
  { key: 'larkAppSecret', label: 'LARK_APP_SECRET', hint: 'Feishu app secret', secret: true },
  { key: 'tmuxThreadChatId', label: 'CLAWX_TMUX_THREAD_CHAT_ID', hint: 'chat_id of the group that hosts /new-tmux session threads' },
]

export interface ConfigDrawerProps {
  open: boolean
  cfg: ConfigResponse | null
  saving: boolean
  onOpenChange: (v: boolean) => void
  onSubmit: (body: Record<string, string>) => Promise<void>
}

/** Right-side sheet with the config form. Presentational + form state local. */
export function ConfigDrawer({
  open,
  cfg,
  saving,
  onOpenChange,
  onSubmit,
}: ConfigDrawerProps): JSX.Element {
  async function handle(ev: React.FormEvent<HTMLFormElement>): Promise<void> {
    ev.preventDefault()
    const fd = new FormData(ev.currentTarget)
    const body: Record<string, string> = {}
    for (const f of CONFIG_FIELDS) {
      const v = String(fd.get(f.key) ?? '').trim()
      if (v) body[f.key] = v
    }
    await onSubmit(body)
    // Caller decides whether to clear fields or close drawer; we just hand off.
    if (Object.keys(body).length > 0) ev.currentTarget.reset()
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Configuration</SheetTitle>
          <SheetDescription>
            Stored at <span className="font-mono text-xs">{cfg?.path ?? 'loading…'}</span>. Changes take effect after
            <span className="font-medium"> restarting clawx</span>. Leave a secret blank to keep its current value.
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handle} className="mt-6 space-y-4">
          {CONFIG_FIELDS.map((f) => {
            const current = cfg?.config[f.key]
            const isSecret = f.secret
            const secretInfo = isSecret ? (current as { preview: string; set: boolean } | undefined) : undefined
            const plain = !isSecret ? ((current as string | undefined) ?? '') : ''
            const placeholder = isSecret
              ? secretInfo?.set
                ? `${secretInfo.preview} (set — leave blank to keep)`
                : f.hint
              : f.hint
            return (
              <div key={f.key} className="grid gap-1.5">
                <Label htmlFor={f.key} className="font-mono text-xs text-muted-foreground">
                  {f.label}
                </Label>
                <Input
                  id={f.key}
                  name={f.key}
                  type={isSecret ? 'password' : 'text'}
                  placeholder={placeholder}
                  defaultValue={plain}
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">{f.hint}</p>
              </div>
            )
          })}

          <SheetFooter className="!mt-8 gap-2 sm:space-x-0">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
