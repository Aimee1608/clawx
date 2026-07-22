export type AgentKind = 'claude' | 'codex'

export function normalizeAgentKind(v: unknown): AgentKind | null {
  if (v === undefined || v === null || v === '') return 'claude'
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  if (!s || s === 'claude') return 'claude'
  if (s === 'codex') return 'codex'
  return null
}

export function agentDisplayName(kind: AgentKind | undefined): string {
  return (kind ?? 'claude') === 'codex' ? 'Codex' : 'Claude'
}

export function agentIdLabel(kind: AgentKind | undefined): string {
  return (kind ?? 'claude') === 'codex' ? 'codex' : 'claude'
}

/** Valid `claude --effort` values (adaptive-reasoning depth), shallow →
 * deep. `ultracode` needs Claude Code v2.1.203+. Claude-only — codex has
 * its own reasoning knobs and ignores this. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

export function isValidEffort(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v)
}
