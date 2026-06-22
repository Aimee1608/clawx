// Read Claude Code's native Agent Teams state (~/.claude/teams/<name>/config.json)
// and map members to their session jsonl files. We own none of this state —
// read-only consumers of what Agent Teams maintains.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { TeamInfo, TeamMember } from './types.js'

function teamsRoot(): string {
  return path.join(os.homedir(), '.claude', 'teams')
}

interface RawMember {
  agentId?: string
  name?: string
  agentType?: string
  tmuxPaneId?: string
  prompt?: string
}

interface RawTeamConfig {
  name?: string
  leadSessionId?: string
  members?: RawMember[]
}

/**
 * Find the team for a room: prefer exact name; else newest team dir created
 * after the room started (lead names the team itself, so we tolerate both).
 */
export function findTeam(createdAtMs: number, preferName?: string): TeamInfo | null {
  const root = teamsRoot()
  if (!fs.existsSync(root)) return null
  const candidates: { dir: string; mtime: number }[] = []
  for (const name of fs.readdirSync(root)) {
    const cfg = path.join(root, name, 'config.json')
    if (!fs.existsSync(cfg)) continue
    const mtime = fs.statSync(cfg).mtimeMs
    if (preferName && name === preferName) {
      candidates.unshift({ dir: path.join(root, name), mtime: Number.MAX_SAFE_INTEGER })
      continue
    }
    if (mtime >= createdAtMs - 10_000) candidates.push({ dir: path.join(root, name), mtime })
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  const top = candidates[0]
  if (!top) return null
  return parseTeamConfig(top.dir)
}

export function parseTeamConfig(teamDir: string): TeamInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(teamDir, 'config.json'), 'utf8')) as RawTeamConfig
    if (!raw.name || !raw.leadSessionId || !Array.isArray(raw.members)) return null
    const members: TeamMember[] = raw.members.map((m) => ({
      name: m.name ?? 'unknown',
      paneId: m.tmuxPaneId ?? '',
      isLead: m.agentType === 'team-lead',
      promptHead: (m.prompt ?? '').slice(0, 120),
      prompt: m.prompt ?? '',
    }))
    return { name: raw.name, dir: teamDir, leadSessionId: raw.leadSessionId, members }
  } catch {
    return null
  }
}

// ── session jsonl discovery ──────────────────────────────────────────

function projectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects')
}

function slugFull(cwd: string): string {
  // Claude Code slugs project dirs from the FULL cwd path with
  // non-alphanumerics replaced by '-'. Exact match avoids colliding with
  // sibling projects (e.g. <repo> vs <repo>/apps/xxx both contain the
  // repo basename).
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export function projectDirForCwd(cwd: string): string | null {
  const root = projectsRoot()
  if (!fs.existsSync(root)) return null
  const exact = path.join(root, slugFull(cwd))
  if (fs.existsSync(exact)) return exact
  // Fallback: substring match on the slug, newest dir wins.
  const tail = path.basename(cwd).replace(/[^a-zA-Z0-9]/g, '-')
  const hits = fs
    .readdirSync(root)
    .filter((d) => d.includes(tail))
    .map((d) => path.join(root, d))
  if (hits.length === 0) return null
  hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return hits[0] ?? null
}

/** All session jsonls in the project dir touched after the room started. */
export function listSessionJsonls(projectDir: string, sinceMs: number): string[] {
  if (!fs.existsSync(projectDir)) return []
  return fs
    .readdirSync(projectDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(projectDir, f))
    .filter((f) => fs.statSync(f).mtimeMs >= sinceMs - 10_000)
}
