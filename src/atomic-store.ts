// adapted from clawbot-hub src/features/feature-store.ts @ a73086f
// Generic atomic JSON persistence + per-key in-process lock (feature-specific
// logic stripped; this is the reusable persistence kernel).
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** Atomic write: rotate .bak (best-effort), write tmp, rename. */
export function atomicWriteJson(target: string, value: unknown): void {
  const dir = path.dirname(target)
  fs.mkdirSync(dir, { recursive: true })
  if (fs.existsSync(target)) {
    try {
      fs.copyFileSync(target, `${target}.bak`)
    } catch {
      // .bak is a safety net; failure here doesn't block the write.
    }
  }
  const tmp = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, target)
}

/** Read JSON with fall-through to `.bak` on read/parse failure. */
export function readJsonWithBak<T>(target: string, parse: (raw: string) => T | null): T | null {
  if (!fs.existsSync(target)) return null
  try {
    const parsed = parse(fs.readFileSync(target, 'utf8'))
    if (parsed) return parsed
  } catch {
    // fall through to bak
  }
  const bak = `${target}.bak`
  if (fs.existsSync(bak)) {
    try {
      const parsed = parse(fs.readFileSync(bak, 'utf8'))
      if (parsed) return parsed
    } catch {
      /* fall through */
    }
  }
  return null
}

const locks = new Map<string, Promise<unknown>>()

/**
 * Run `fn` with exclusive access to `key`. Use around any (read → mutate →
 * write) sequence. In-process only — a single daemon owns the data dir.
 */
export async function withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  const result = previous.then(() => fn())
  locks.set(key, result.catch(() => undefined))
  return result
}
