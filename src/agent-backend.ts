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
