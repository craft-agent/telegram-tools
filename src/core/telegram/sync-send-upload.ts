import { tl } from "@mtcute/core"
import { ToolError } from "../errors"
import { isSessionEnded } from "./rpc-errors"
import type { ResolvedSyncOptions } from "./sync-options"
import { errorLabel } from "./sync-outcome"
import type { TelegramCallContext } from "./sync-request-calls"
import { abortable, cancelled, requestFailure } from "./sync-request-errors"
import type { OutboxFile } from "./sync-send-outbox"
import { refusalOf } from "./sync-send-outcome"
import type { SyncTelegram } from "./sync-telegram"

/** What uploading the files of a send works with; the send's context holds all of it. */
export type UploadContext = TelegramCallContext & {
  client: Pick<SyncTelegram, "uploadFile" | "call">
  settings: Pick<ResolvedSyncOptions, "log" | "transferStallMs">
}

/** A file on Telegram's servers that no message holds yet. */
export type UploadedFile = {
  name: string
  inputFile: tl.TypeInputFile
  /** The type mtcute worked out from the file's first bytes. */
  mime: string
}

/**
 * The error of an upload step that failed before anything was sent. The
 * caller leaving is `cancelled`; a session that ended ends the run; a refusal
 * Telegram gave stands as it does for a send; any other failure is named by
 * Telegram's error name or the error's class, never its message.
 */
function uploadFailure(ctx: UploadContext, signal: AbortSignal, error: unknown, name: string): Error {
  if (signal.aborted) return cancelled()
  if (error instanceof ToolError) return error
  if (isSessionEnded(error))
    return requestFailure(error, "upload", { endSession: ctx.endSession, log: ctx.settings.log })
  ctx.settings.log(`upload failed: ${errorLabel(error)}`)
  const refusal = tl.RpcError.is(error) ? refusalOf(error) : undefined
  return (
    refusal ?? new ToolError("upstream_error", `The upload of ${name} failed (${errorLabel(error)}); nothing was sent.`)
  )
}

/**
 * Uploads one file and answers with it. mtcute retries the parts and waits out
 * flood waits inside an upload without end, so an upload whose progress does
 * not grow for `transferStallMs` is aborted and fails as `upstream_error`.
 */
async function uploadOne(ctx: UploadContext, signal: AbortSignal, file: OutboxFile): Promise<UploadedFile> {
  const stallMs = ctx.settings.transferStallMs
  const stall = new AbortController()
  const uploadSignal = AbortSignal.any([signal, stall.signal])
  let stalled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const startTimer = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      stalled = true
      stall.abort()
    }, stallMs)
  }
  let uploaded = 0
  const stream = file.stream()
  startTimer()
  try {
    const result = await abortable(
      ctx.client.uploadFile({
        file: stream,
        fileName: file.name,
        fileSize: file.size,
        abortSignal: uploadSignal,
        progressCallback: (bytes) => {
          if (bytes <= uploaded) return
          uploaded = bytes
          startTimer()
        },
      }),
      uploadSignal,
    )
    return { name: file.name, inputFile: result.inputFile, mime: result.mime }
  } catch (error) {
    if (stalled) throw new ToolError("upstream_error", `The upload of ${file.name} stalled; nothing was sent.`)
    throw uploadFailure(ctx, signal, error, file.name)
  } finally {
    clearTimeout(timer)
    stream.destroy()
  }
}

/** Uploads the files one after the other, in order; the first failure ends it, with nothing sent. */
export async function uploadFiles(
  ctx: UploadContext,
  signal: AbortSignal,
  files: readonly OutboxFile[],
): Promise<UploadedFile[]> {
  const uploaded: UploadedFile[] = []
  for (const file of files) {
    if (signal.aborted) throw cancelled()
    uploaded.push(await uploadOne(ctx, signal, file))
  }
  return uploaded
}

/** The media that sends an uploaded file as a file, with its name, never as a photo or a video. */
export function uploadedDocumentOf({ name, inputFile, mime }: UploadedFile): tl.RawInputMediaUploadedDocument {
  return {
    _: "inputMediaUploadedDocument",
    file: inputFile,
    mimeType: mime,
    attributes: [{ _: "documentAttributeFilename", fileName: name }],
    forceFile: true,
  }
}

/**
 * Turns an uploaded file into the document a group is built of, with
 * `messages.uploadMedia`, which makes no message. Done once for each file of
 * a group; the failures are those of an upload.
 */
export async function documentOf(
  ctx: UploadContext,
  signal: AbortSignal,
  peer: tl.TypeInputPeer,
  file: UploadedFile,
): Promise<tl.RawInputMediaDocument> {
  if (signal.aborted) throw cancelled()
  try {
    const request: tl.messages.RawUploadMediaRequest = {
      _: "messages.uploadMedia",
      peer,
      media: uploadedDocumentOf(file),
    }
    const media = await abortable(ctx.client.call(request, { abortSignal: signal }), signal)
    if (media._ !== "messageMediaDocument" || media.document?._ !== "document") {
      throw new ToolError("upstream_error", `Telegram did not take ${file.name}; nothing was sent.`)
    }
    const { id, accessHash, fileReference } = media.document
    return { _: "inputMediaDocument", id: { _: "inputDocument", id, accessHash, fileReference } }
  } catch (error) {
    throw uploadFailure(ctx, signal, error, file.name)
  }
}
