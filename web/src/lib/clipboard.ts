/**
 * Copy text to the clipboard, falling back when `navigator.clipboard`
 * isn't available.
 *
 * Why a helper: `navigator.clipboard.writeText` is restricted to
 * secure contexts (HTTPS / localhost / 127.0.0.1). clawx's web UI
 * is typically reached over `http://<dev-box-ip>:8123/`, which most
 * browsers consider insecure and where `navigator.clipboard` is
 * `undefined`. Calling `.writeText` on it throws `TypeError: Cannot
 * read properties of undefined`.
 *
 * Fallback path uses a hidden `<textarea>` + `document.execCommand
 * ('copy')`. Deprecated but still implemented everywhere; works in
 * insecure contexts because user activation is implicit (we're
 * called from a click handler).
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

  // Legacy fallback: hidden textarea + execCommand.
  if (typeof document === 'undefined') return false
  const ta = document.createElement('textarea')
  ta.value = text
  // Keep it off-screen but selectable; readOnly prevents iOS soft-kb.
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '-1000px'
  ta.style.left = '-1000px'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  try {
    ta.select()
    ta.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    return ok
  } catch {
    return false
  } finally {
    document.body.removeChild(ta)
  }
}
