import fs from 'node:fs'
import path from 'node:path'

import * as lark from '@larksuiteoapi/node-sdk'

import { log } from './logger.js'
import { dataDir } from './config.js'

/**
 * Lark message resource (image / file) download. The SDK's
 * `im.messageResource.get` returns a streaming wrapper with a
 * `writeFile(path)` convenience method — we shell out to that and
 * return the saved path so callers can hand it off to claude via
 * `@path` references in the REPL.
 *
 * Images go to `~/.local/share/clawx/imgs/<message_id>-<idx>.<ext>`.
 * No automatic GC yet: clawx doesn't know when a session is "done
 * with" an image. Run a periodic `find ... -mtime +7 -delete` cron
 * separately if disk is tight.
 */

export interface DownloadOpts {
  client: lark.Client
  messageId: string
  /** The image_key / file_key embedded in the message content. */
  fileKey: string
  /** Lark resource type — passed as the `type` query param. */
  type: 'image' | 'file'
  /** Filename suggestion (used as the final basename). Extension is
   * inferred when omitted: `.jpg` for image, `.bin` for file. */
  filename?: string
  /** Override the destination directory. Defaults to the per-resource
   * dir under XDG_DATA_HOME. */
  destDir?: string
}

export function defaultImageDir(): string {
  return path.join(dataDir(), 'imgs')
}

export async function downloadMessageResource(
  opts: DownloadOpts,
): Promise<string> {
  const dir = opts.destDir ?? defaultImageDir()
  fs.mkdirSync(dir, { recursive: true })
  const ext = opts.type === 'image' ? '.jpg' : '.bin'
  const basename = (opts.filename ?? '').trim() || `${opts.messageId}-${opts.fileKey.slice(-8)}${ext}`
  const dest = path.join(dir, basename)

  const res = await opts.client.im.messageResource.get({
    path: { message_id: opts.messageId, file_key: opts.fileKey },
    params: { type: opts.type },
  })
  // The SDK exposes writeFile on the streaming response. Some
  // versions return a plain stream — handle both.
  const w = res as unknown as {
    writeFile?: (p: string) => Promise<void> | void
    pipe?: (dst: NodeJS.WritableStream) => void
  }
  if (typeof w.writeFile === 'function') {
    await w.writeFile(dest)
  } else if (typeof w.pipe === 'function') {
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(dest)
      w.pipe!(out)
      out.on('finish', () => resolve())
      out.on('error', reject)
    })
  } else {
    throw new Error('lark messageResource.get returned an unrecognized shape')
  }

  log.debug('lark resource saved', {
    messageId: opts.messageId,
    fileKey: opts.fileKey,
    dest,
    bytes: fs.statSync(dest).size,
  })
  return dest
}
