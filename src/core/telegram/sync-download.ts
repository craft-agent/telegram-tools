import { open, type FileHandle } from "node:fs/promises"
import { MtTimeoutError, type Message, type MessageMedia } from "@mtcute/core"
import { ToolError } from "../errors"
import { mediaOf, mediaTimerOf } from "./from-mtcute-media"
import { markedId, readOrNull } from "./from-mtcute-parts"
import { labelPaths } from "./labels"
import type { Mirror } from "./mirror"
import { isCount } from "./mirror-input"
import type { DeclaredFile, DownloadParams, DownloadResult, SavedFile } from "./service-requests"
import type { ServiceCall } from "./service-server"
import { createDownloadFolder, discardFolder } from "./sync-incoming"
import type { ResolvedSyncOptions } from "./sync-options"
import { declaredRefusal, tooLargeReason } from "./sync-download-refusal"
import { listedChat, viaTelegram, type TelegramCallContext } from "./sync-request-calls"
import { abortable, cancelled, requestFailure } from "./sync-request-errors"
import { parseDownloadParams } from "./sync-request-params"
import type { RequestQueue } from "./sync-request-queue"
import type { SyncTelegram } from "./sync-telegram"

/** What the download request works with; the sync requests' context holds all of it. */
export type DownloadContext = TelegramCallContext & {
  client: Pick<SyncTelegram, "getMessages" | "downloadAsIterable">
  mirror: Mirror
  settings: Pick<ResolvedSyncOptions, "stateDir" | "label" | "log" | "downloadStallMs">
}

/**
 * How long a download may receive nothing before it stops, in milliseconds.
 * mtcute waits out flood waits and retries failed parts inside a download
 * without end; this is what bounds those sleeps and retries.
 */
export const DOWNLOAD_STALL_MS = 60_000

/** The permissions of a downloaded file: the owner reads and writes it, and nobody runs it. */
const FILE_MODE = 0o600

const MS_PER_S = 1000

/** The kinds of media (`MediaInfo.type`) that are a file Telegram serves. */
const FILE_KINDS = ["photo", "document", "audio", "voice", "video", "sticker"] as const

type FileMedia = Extract<NonNullable<MessageMedia>, { type: (typeof FILE_KINDS)[number] }>

/** A message's file: what to download, and what Telegram declares of it. */
type MessageFile = { media: FileMedia; declared: DeclaredFile }

function isFileMedia(media: MessageMedia): media is FileMedia {
  return media !== null && (FILE_KINDS as readonly string[]).includes(media.type)
}

/**
 * The file a message carries. `not_found` when it carries none, naming what it
 * does carry; `forbidden` when it can be opened once or disappears after being
 * opened, since its sender meant it to be seen once.
 */
function fileOf(message: Message, id: number): MessageFile {
  const info = mediaOf(message)
  const media = readOrNull(() => message.media)
  if (!info || !media || !isFileMedia(media)) {
    throw new ToolError("not_found", `Message ${id} has no file to save; it carries ${info?.type ?? "only text"}.`)
  }
  const { viewOnce, selfDestruct } = mediaTimerOf(message)
  if (viewOnce || selfDestruct !== null) {
    throw new ToolError("forbidden", "This file was meant to be seen once; it is not saved.")
  }
  // A size that is no byte count (a photo whose sizes are empty) is no size.
  const size = isCount(info.size) ? info.size : null
  return { media, declared: { name: info.name ?? null, type: info.mime ?? null, size, kind: info.type } }
}

/** The error of a download that received nothing for `stallMs`: mtcute's stall limit, which is not the caller leaving. */
function stalled(stallMs: number): ToolError {
  return new ToolError(
    "upstream_error",
    `The download received nothing for ${stallMs / MS_PER_S} seconds; try again later.`,
  )
}

/** Writes all of `chunk` at the file's current position. */
async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
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
async function writeDownload(
  ctx: DownloadContext,
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

/**
 * Downloads the file into a folder of its own and answers with where it is.
 * A download that passes `max`, fails or is cancelled leaves no folder: it is
 * removed before the answer or the error.
 */
async function saveFile(
  ctx: DownloadContext,
  signal: AbortSignal,
  message: Message,
  { media, declared }: MessageFile,
  max: number,
): Promise<DownloadResult> {
  const folder = await createDownloadFolder(labelPaths(ctx.settings.stateDir, ctx.settings.label).incoming)
  let kept = false
  try {
    const size = await writeDownload(ctx, signal, media, folder.file, max)
    if (size === undefined) return { refused: { ...declared, reason: tooLargeReason(declared.size, max) } }
    const ttl = message.ttlPeriod
    const saved: SavedFile = {
      path: folder.file,
      name: declared.name,
      type: declared.type,
      size,
      kind: declared.kind,
      ...(ttl ? { disappears_at: message.date.getTime() + ttl * MS_PER_S } : {}),
    }
    kept = true
    return { saved }
  } finally {
    if (!kept) await discardFolder(folder.dir).catch(() => ctx.settings.log("a download folder could not be removed"))
  }
}

/** The file of message `id` of `chat` taken from Telegram, or the reason it is refused; see `downloadRequest`. */
async function downloadFile(
  ctx: DownloadContext,
  call: ServiceCall,
  signal: AbortSignal,
  { chat, id, max_bytes }: DownloadParams,
): Promise<DownloadResult> {
  const [message] = await viaTelegram(ctx, call, "download", () => ctx.client.getMessages(Number(chat), id))
  // Telegram numbers the messages of private chats and basic groups together; the chat the caller named is the one that counts.
  if (!message || markedId(message.raw.peerId) !== chat)
    throw new ToolError("not_found", `No message ${id} in this chat.`)

  const file = fileOf(message, id)
  const { declared } = file
  const reason =
    declaredRefusal(declared) ??
    (declared.size !== null && declared.size > max_bytes ? tooLargeReason(declared.size, max_bytes) : undefined)
  if (reason !== undefined) return { refused: { ...declared, reason } }
  return saveFile(ctx, signal, message, file, max_bytes)
}

/**
 * Answers a `download` request: takes message `id` of a chat the mirror lists
 * from Telegram again, and downloads its file into a folder of its own under
 * the label's `incoming/`, as `file`. A file whose declared name, type or size
 * is refused is not downloaded, and a download that passes `max_bytes` stops;
 * both are an answer (`refused`), not an error. Downloads run one at a time
 * through `queue`.
 */
export function downloadRequest(
  ctx: DownloadContext,
  queue: RequestQueue,
  raw: unknown,
  call: ServiceCall,
): Promise<DownloadResult> {
  const params = parseDownloadParams(raw)
  listedChat(ctx.mirror, params.chat)
  const signal = AbortSignal.any([call.signal, ctx.signal])
  return queue.run(signal, () => downloadFile(ctx, call, signal, params))
}
