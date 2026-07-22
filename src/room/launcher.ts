// Launch a room: tmux session + lead claude REPL (Agent Teams enabled) +
// opening prompt. The bridge (bridge.ts) takes over from there.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { log } from '../logger.js'
import type { RoomState } from './types.js'
import { newRoomId, saveRoom, roomDir } from './room-store.js'
import { loadTemplate, buildLeadPrompt } from './templates.js'
import { loadLarkApps, isTopicChat } from './lark-multi.js'
import { brand, dataDir } from '../config.js'
import fs from 'node:fs'
import path from 'node:path'

const execFileP = promisify(execFile)

async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileP('tmux', args)
  return stdout
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

const PROXY = 'http://127.0.0.1:7890'

/**
 * Write (idempotently) a clawx-owned settings file carrying ONLY
 * `teammateMode: "tmux"`, and return its path for `claude --settings`.
 *
 * Why: Agent Teams needs teammateMode=tmux so each teammate gets its
 * own tmux pane — that's how bridge.ts routes messages to individual
 * teammates by paneId. But this dependency must NOT live in the user's
 * global ~/.claude/settings.json (other claude sessions rewrite that
 * file and silently drop the key) nor in the project's .claude/ (would
 * pollute the repo AND flip teammateMode for every plain claude run in
 * that directory). `--settings` merges on top: ONLY this key is added;
 * model / env / proxy / permissions still inherit from global. So room
 * self-supplies its requirement without touching anything global. */
function ensureRoomSettingsFile(): string {
  const p = path.join(dataDir(), 'room-teammate-settings.json')
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify({ teammateMode: 'tmux' }, null, 2))
  return p
}

export interface LaunchOpts {
  /** short label (topic title / tmux display) */
  label: string
  /** full brief for the agents; empty = standby (user describes it later) */
  topic?: string
  cwd: string
  chatId: string
  /** template name (scene layer); defaults to built-in 'design' */
  template?: string
}

export async function launchRoom(opts: LaunchOpts): Promise<RoomState> {
  const id = newRoomId()
  const tmuxSession = `${brand()}-room-${id}`
  const teamName = `room-${id}`

  fs.mkdirSync(roomDir(id), { recursive: true })

  // 1. tmux session with the lead REPL (Agent Teams + mihomo proxy forced).
  await tmux('new-session', '-d', '-s', tmuxSession, '-x', '220', '-y', '50', '-c', opts.cwd)
  // MAX_THINKING_TOKENS caps the lead/teammates' extended thinking so opus
  // can't spiral into a non-converging multi-minute think on a heavy task
  // (e.g. reading a big intel库 before the kickoff gate). Cap, don't disable
  // — they still get a solid budget for debate.
  // teammateMode=tmux via a clawx-owned --settings file so we don't
  // depend on (or touch) the user's global ~/.claude/settings.json.
  const roomSettings = ensureRoomSettingsFile()
  const launch =
    `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 MAX_THINKING_TOKENS=16000 ` +
    `HTTP_PROXY=${PROXY} HTTPS_PROXY=${PROXY} http_proxy=${PROXY} https_proxy=${PROXY} ` +
    `claude --settings "${roomSettings}"`
  await tmux('send-keys', '-t', tmuxSession, '-l', launch)
  await tmux('send-keys', '-t', tmuxSession, 'Enter')

  // 2. Wait for the REPL prompt (startup dialogs are absent on trusted dirs;
  //    if one ever appears the capture loop surfaces it in the log).
  let ready = false
  for (let i = 0; i < 45; i++) {
    await sleep(2000)
    const pane = await tmux('capture-pane', '-t', tmuxSession, '-p')
    if (pane.includes('❯')) {
      ready = true
      break
    }
  }
  if (!ready) {
    log.warn('lead REPL not ready in 90s — sending prompt anyway', { tmuxSession })
  }

  const leadPaneId = (await tmux('list-panes', '-t', tmuxSession, '-F', '#{pane_id}'))
    .trim()
    .split('\n')[0]

  // clawx-style display label: status bar + window/terminal title.
  const created = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 10)
  const safeLabel = opts.label.replace(/[^\p{L}\p{N} _·-]/gu, '').slice(0, 30) || id
  try {
    await tmux('set-option', '-t', tmuxSession, 'status-left', `[${safeLabel} · ${created} · ${id}] `)
    await tmux('set-option', '-t', tmuxSession, 'status-left-length', '60')
    await tmux('rename-window', '-t', tmuxSession, safeLabel)
    await tmux('set-option', '-t', tmuxSession, 'set-titles', 'on')
  } catch {
    /* cosmetic — never block launch */
  }

  // 3. Opening prompt: scene layer from the chosen template, wrapped in the
  //    mechanism + discipline sandwich. with-topic starts immediately;
  //    standby waits for the user to describe the topic first.
  const cfgForName = loadLarkApps()
  const userName = cfgForName?.userName ?? '用户'
  const templateName = opts.template ?? 'design'
  const tpl = loadTemplate(templateName, opts.cwd) ?? loadTemplate('design', opts.cwd)!
  const prompt = buildLeadPrompt({ sceneBody: tpl.body, teamName, userName, topic: opts.topic })
  await tmux('send-keys', '-t', tmuxSession, '-l', prompt.replace(/\n/g, ' '))
  await sleep(500)
  await tmux('send-keys', '-t', tmuxSession, 'Enter')

  const fleetCfg = loadLarkApps()
  const larkMode: 'p2p' | 'topic' =
    fleetCfg && isTopicChat(fleetCfg, opts.chatId) ? 'topic' : 'p2p'

  const room: RoomState = {
    id,
    label: opts.label,
    topic: opts.topic ?? '',
    cwd: opts.cwd,
    chatId: opts.chatId,
    template: tpl.name,
    codexReview: tpl.codexReview,
    larkMode,
    tmuxSession,
    leadPaneId,
    teamName,
    status: 'starting',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    jsonlOffsets: {},
    memberJsonl: {},
    memberPane: {},
    larkSinceMs: Date.now(),
  }
  saveRoom(room)
  log.info('room launched', { id, tmuxSession, teamName, label: opts.label })
  return room
}

export async function killRoom(room: RoomState): Promise<void> {
  try {
    await tmux('kill-session', '-t', room.tmuxSession)
  } catch {
    /* already gone */
  }
}
