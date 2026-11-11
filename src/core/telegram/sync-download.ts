import type { Message } from "@mtcute/core"
import { ToolError } from "../errors"
import { mediaOf, mediaTimerOf } from "./from-mtcute-media"
import { markedId } from "./from-mtcute-parts"
import { labelPaths } from "./labels"
import type { Mirror } from "./mirror"
import type { DownloadParams, DownloadResult } from "./service-requests"
import type { ServiceCall } from "./service-server"
import { disappearsAtOf, messageFile, type MessageFile } from "./sync-download-file"
import { declaredRefusal, tooLargeReason } from "./sync-download-refusal"
import { writeDownload, type DownloadStreamContext } from "./sync-download-stream"
import { createDownloadFolder, discardFolder } from "./sync-incoming"
import { copyKeptFile, findKept } from "./sync-kept-store"
import type { ResolvedSyncOptions } from "./sync-options"
import { listedChat, viaTelegram } from "./sync-request-calls"
import { parseDownloadParams } from "./sync-request-params"
import type { RequestQueue } from "./sync-request-queue"
import type { SyncTelegram } from "./sync-telegram"

/** What the download request works with; the sync requests' context holds all of it. */
export type DownloadContext = DownloadStreamContext & {
  client: Pick<SyncTelegram, "getMessages" | "downloadAsIterable">
  mirror: Mirror
  settings: Pick<ResolvedSyncOptions, "stateDir" | "label" | "log" | "transferStallMs">
}

/**
 * The file a message carries. `not_found` when it carries none, naming what it
 * does carry; `forbidden` when it can be opened once or disappears after being
 * opened, since its sender meant it to be seen once.
 */
function fileOf(message: Message, id: number): MessageFile {
  const file = messageFile(message)
  if (!file) {
    throw new ToolError(
      "not_found",
      `Message ${id} has no file to save; it carries ${mediaOf(message)?.type ?? "only text"}.`,
    )
  }
  const { viewOnce, selfDestruct } = mediaTimerOf(message)
  if (viewOnce || selfDestruct !== null) {
    throw new ToolError("forbidden", "This file was meant to be seen once; it is not saved.")
  }
  return file
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
    const disappearsAt = disappearsAtOf(message)
    kept = true
    return {
      saved: {
        path: folder.file,
        name: declared.name,
        type: declared.type,
        size,
        kind: declared.kind,
        ...(disappearsAt === undefined ? {} : { disappears_at: disappearsAt }),
      },
    }
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
 * The copy `keep_disappearing` kept of message `id` as it arrived, copied into
 * a folder of its own under `incoming/`; undefined when none was kept, and then
 * Telegram is asked. The copy is served without asking Telegram, so it works
 * once the message has expired there. Over `max_bytes` it is refused, as a
 * download is.
 */
async function keptCopy(
  ctx: DownloadContext,
  { chat, id, max_bytes }: DownloadParams,
): Promise<DownloadResult | undefined> {
  const { stateDir, label, log } = ctx.settings
  const paths = labelPaths(stateDir, label)
  const copy = await findKept(paths.kept, chat, id, log)
  if (!copy) return undefined
  const { meta, size } = copy
  if (size > max_bytes) {
    return {
      refused: { name: meta.name, type: meta.type, size, kind: meta.kind, reason: tooLargeReason(size, max_bytes) },
    }
  }
  const folder = await createDownloadFolder(paths.incoming)
  try {
    const copied = await copyKeptFile(copy.file, folder.file)
    return { saved: { ...meta, size: copied, path: folder.file, kept: true } }
  } catch (error) {
    await discardFolder(folder.dir).catch(() => log("a download folder could not be removed"))
    throw error
  }
}

/**
 * Answers a `download` request: the copy `keep_disappearing` kept of message
 * `id` of a chat the mirror lists when there is one, else the message taken
 * from Telegram again, its file downloaded into a folder of its own under the
 * label's `incoming/`, as `file`. A file whose declared name, type or size
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
  return keptCopy(ctx, params).then((kept) => kept ?? queue.run(signal, () => downloadFile(ctx, call, signal, params)))
}
