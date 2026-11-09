import { open, type FileHandle } from "node:fs/promises"
import { MtTimeoutError } from "@mtcute/core"
import { ToolError } from "../errors"
import type { ResolvedSyncOptions } from "./sync-options"
import type { FileMedia } from "./sync-download-file"
import { abortable, cancelled, requestFailure } from "./sync-request-errors"
import type { TelegramCallContext } from "./sync-request-calls"
import type { SyncTelegram } from "./sync-telegram"

/** What streaming a download to disk works with; the download request's and the keeper's contexts hold all of it. */
export type DownloadStreamContext = TelegramCallContext & {
  client: Pick<SyncTelegram, "downloadAsIterable">
  settings: Pick<ResolvedSyncOptions, "log" | "downloadStallMs">
}

/** The permissions of a downloaded file: the owner reads and writes it, and nobody runs it. */
export const FILE_MODE = 0o600

const MS_PER_S = 1000

/** The error of a download that received nothing for `stallMs`: mtcute's stall limit, which is not the caller leaving. */
function stalled(stallMs: number): ToolError {
  return new ToolError(
    "upstream_error",
    `The download received nothing for ${stallMs / MS_PER_S} seconds; try again later.`,
  )
}

/** Writes all of `chunk` at the file's current position. */
export async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < chunk.length) offset += (await handle.write(chunk, offset)).bytesWritten
}

/**
 * Downloads `media` into the new file at `file`, chunk after chunk. Resolves
 * with the bytes written, or `undefined` when the next chunk would pass `max`:
 * it stops there, and the caller removes the file. Telegram's failures become
 * the request's errors, a flood wait among them is told and not retried; a
 * download that receives nothing for `downloadStallMs` ends as `upstream_error`;
 * a failure to write the file is the service's own and passes through. The file
 * is closed, and nothing writes to it any more, when this settles.
 */
export async function writeDownload(
  ctx: DownloadStreamContext,
  signal: AbortSignal,
  media: FileMedia,
  file: string,
  max: number,
): Promise<number | undefined> {
  const env = { endSession: ctx.endSession, log: ctx.settings.log }
  const stallMs = ctx.settings.downloadStallMs
  const failure = (error: unknown): Error => {
    if (signal.aborted) return cancelled()
    if (error instanceof MtTimeoutError && error.timeout === stallMs) return stalled(stallMs)
    return requestFailure(error, "download", env)
  }
  const fromTelegram = <T>(work: () => T | Promise<T>): Promise<T> =>
    abortable(Promise.resolve().then(work), signal).catch((error) => {
      throw failure(error)
    })

  const handle = await open(file, "wx", FILE_MODE)
  let chunks: AsyncIterableIterator<Uint8Array> | undefined
  try {
    const iterator = await fromTelegram(() =>
      ctx.client.downloadAsIterable(media, { abortSignal: signal, stallTimeout: stallMs }),
    )
    chunks = iterator
    let written = 0
    for (;;) {
      const step = await fromTelegram(() => iterator.next())
      if (step.done) return written
      if (written + step.value.length > max) return undefined
      await writeAll(handle, step.value)
      written += step.value.length
    }
  } finally {
    // Not awaited: a download stalled on Telegram would hold the cleanup for as long as it stalls.
    void Promise.resolve(chunks?.return?.()).catch(() => {})
    await handle.close()
  }
}
