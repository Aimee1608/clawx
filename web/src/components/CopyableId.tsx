import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { copyToClipboard } from '@/lib/clipboard'

/**
 * A monospace ID display that copies its full value to the clipboard on
 * click. Renders the trailing copy icon only on hover so quiet rows stay
 * visually quiet. Pure presentational + clipboard side-effect; no fetch
 * or app state.
 */
export function CopyableId({ value, label }: { value: string; label?: string }): JSX.Element {
  const [copied, setCopied] = useState(false)

  async function doCopy(): Promise<void> {
    const ok = await copyToClipboard(value)
    if (ok) {
      setCopied(true)
      toast.success(`${label ?? 'id'} copied`)
      setTimeout(() => setCopied(false), 1500)
    } else {
      toast.error('clipboard unavailable — select manually')
    }
  }

  return (
    <button
      type="button"
      onClick={doCopy}
      className="group inline-flex items-center gap-1.5 rounded px-1 py-0.5 font-mono text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      title={`click to copy: ${value}`}
    >
      <span>{value}</span>
      {copied ? (
        <Check className="h-3 w-3 text-emerald-600" />
      ) : (
        <Copy className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
      )}
    </button>
  )
}
