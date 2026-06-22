// Room persistence — same atomic conventions as run-store.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { atomicWriteJson, readJsonWithBak, withLock } from '../atomic-store.js'
import { dataDir } from '../config.js'
import type { RoomState } from './types.js'

function roomsRoot(): string {
  return path.join(dataDir(), 'rooms')
}

export function roomDir(id: string): string {
  return path.join(roomsRoot(), id)
}

function roomFile(id: string): string {
  return path.join(roomDir(id), 'room.json')
}

export function newRoomId(): string {
  return randomUUID().slice(0, 8)
}

/** Single-instance bridge lock (pid file). The bridge itself acquires it on
 * startup, so every launch path — ensureBridge, manual `room bridge`, ad-hoc
 * scripts — is idempotent: a second bridge for the same room exits early. */
export function bridgeLockPath(id: string): string {
  return path.join(roomDir(id), 'bridge.lock')
}

export function readBridgeLockPid(id: string): number | null {
  try {
    const pid = Number(fs.readFileSync(bridgeLockPath(id), 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

export function saveRoom(room: RoomState): void {
  room.updatedAt = Date.now()
  atomicWriteJson(roomFile(room.id), room)
}

export function loadRoom(id: string): RoomState | null {
  return readJsonWithBak(roomFile(id), (raw) => {
    const obj = JSON.parse(raw) as RoomState
    return obj && typeof obj.id === 'string' ? obj : null
  })
}

export async function updateRoom(id: string, mutate: (r: RoomState) => RoomState): Promise<RoomState> {
  return withLock(`room:${id}`, () => {
    const cur = loadRoom(id)
    if (!cur) throw new Error(`room ${id} not found`)
    const next = mutate(cur)
    saveRoom(next)
    return next
  })
}

export function listRooms(): RoomState[] {
  const root = roomsRoot()
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root)
    .map((id) => loadRoom(id))
    .filter((r): r is RoomState => r !== null)
    .sort((a, b) => b.createdAt - a.createdAt)
}
