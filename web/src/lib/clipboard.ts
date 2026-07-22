/**
 * Copy text to the clipboard, falling back when `navigator.clipboard`
 * isn't available.
 *
 * Why a helper: `navigator.clipboard.writeText` is restricted to
 * secure contexts (HTTPS / localhost / 127.0.0.1). clawx's web UI
 * is typically reached over `http://<dev-box-ip>:8124/`, which most
 * browsers consider insecure and where `navigator.clipboard` is
 * `undefined`. Calling `.writeText` on it throws `TypeError: Cannot
 * read properties of undefined`.
 *
 * Returns true on success, false on failure. Callers usually surface
 * a toast based on the result.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // Modern path — only available in secure contexts.
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function'
    ) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to legacy path */
  }

  if (typeof document === 'undefined') return false
  return legacyCopy(text)
}

/**
 * Legacy fallback for insecure contexts (http://<lan-ip>:port), where
 * navigator.clipboard is undefined. Guards two subtle failures that BOTH
 * produce the "toast says success but nothing was copied" symptom:
 *
 *   1. `document.execCommand('copy')` returns `true` even when nothing
 *      was actually put on the clipboard (empty/invalid selection), so
 *      its boolean is NOT a trustworthy success signal.
 *   2. When the copy is triggered from inside a Radix Dialog (our
 *      MessagesDrawer / Sheet), the dialog's focus trap steals focus off
 *      a <textarea> mounted on document.body and clears the selection —
 *      so the copy grabs nothing.
 *
 * Fix: hook the `copy` event to write the exact text (independent of
 * whatever the selection ends up being) and treat the event firing as
 * the real success signal; mount the textarea next to the focused
 * trigger so a dialog focus-trap doesn't yank it out of scope.
 */
function legacyCopy(text: string): boolean {
  const active = document.activeElement as HTMLElement | null
  // Same subtree as the focused trigger → stays inside a dialog's focus
  // trap instead of being pulled out (which clears the selection).
  const host = active?.parentElement ?? document.body

  let copyFired = false
  const onCopy = (e: ClipboardEvent): void => {
    // Write the exact text regardless of the final selection — this is
    // what actually lands on the clipboard, and confirms copy fired.
    e.clipboardData?.setData('text/plain', text)
    e.preventDefault()
    copyFired = true
  }

  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '0'
  ta.style.left = '0'
  ta.style.width = '1px'
  ta.style.height = '1px'
  ta.style.padding = '0'
  ta.style.border = 'none'
  // Near-invisible, but NOT opacity:0 — a fully transparent element is
  // treated as unselectable by some engines, breaking the copy.
  ta.style.opacity = '0.01'
  host.appendChild(ta)

  document.addEventListener('copy', onCopy)
  try {
    ta.focus()
    ta.select()
    ta.setSelectionRange(0, text.length)
    document.execCommand('copy')
  } catch {
    /* copyFired stays false → reported as failure */
  } finally {
    document.removeEventListener('copy', onCopy)
    host.removeChild(ta)
    // Restore focus so the dialog / page doesn't lose its place.
    try {
      active?.focus?.()
    } catch {
      /* ignore */
    }
  }

  // Trust the copy event firing over execCommand's unreliable boolean:
  // if the event never fired, nothing was copied → report failure so the
  // toast is honest instead of a false "success".
  return copyFired
}
