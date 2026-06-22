// Room = one Agent Teams conversation + a Feishu bridge process.
// The team itself (sessions, mailbox, panes) is owned by Claude Code's
// native Agent Teams; the room only launches it and bridges Feishu.

export interface RoomState {
  id: string
  /** short human label — topic title + tmux display (clawx-style) */
  label: string
  /** full brief fed to the agents */
  topic: string
  cwd: string // working dir for the team (truth-source repo)
  chatId: string // Feishu chat the bridge mirrors into
  template?: string // scene-layer template name (e.g. dev, code-review)
  tmuxSession: string // forge-room-<id>
  leadPaneId?: string // first pane (lead REPL)
  teamName?: string // resolved once ~/.claude/teams/<name> appears
  /** feishu surface: legacy p2p chat, or one topic per room in a topic group */
  larkMode?: 'p2p' | 'topic'
  threadRootId?: string // topic root message id (topic mode)
  threadId?: string // topic thread id (topic mode)
  status: 'starting' | 'running' | 'converged' | 'ended'
  createdAt: number
  updatedAt: number
  /** jsonl path -> number of lines already processed */
  jsonlOffsets: Record<string, number>
  /** member name -> session jsonl path (resolved lazily) */
  memberJsonl: Record<string, string>
  /** member name -> tmux pane id (from team config) */
  memberPane: Record<string, string>
  /** Feishu poll watermark (ms) */
  larkSinceMs: number
  /** lead summary already mirrored */
  summaryMirrored?: boolean
  /** template opted into codex heterogeneous review after convergence */
  codexReview?: boolean
  /** how many rounds codex has sent the convergence back for re-debate */
  codexRound?: number
  /** members whose next substantive reply should be mirrored (they were
   * directly addressed by the user) */
  awaitReply?: Record<string, boolean>
  /** members already reported as dead (notice de-dup) */
  deadNotified?: Record<string, boolean>
  /** members whose spawn prompt was already mirrored as a 派活 card */
  spawnEchoed?: Record<string, boolean>
  /** detached bridge process pid */
  bridgePid?: number
  /** last visual @-footer appended to a card (throttle) */
  lastPingMs?: number
  /** last REAL notifying @ (text message; v2 card chips never notify) */
  lastRealPingMs?: number
}

export interface TeamMember {
  name: string
  paneId: string
  isLead: boolean
  promptHead: string // first chars of spawn prompt, for jsonl matching
  prompt: string // full spawn prompt (mirrored to Feishu as the 派活 card)
}

export interface TeamInfo {
  name: string
  dir: string
  leadSessionId: string
  members: TeamMember[]
}
