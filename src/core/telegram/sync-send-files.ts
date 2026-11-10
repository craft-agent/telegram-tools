import { setImmediate } from "node:timers"
import type { Long, tl } from "@mtcute/core"
import { randomLong } from "@mtcute/core/utils.js"
import { labelPaths } from "./labels"
import type { SendFilesParams, SendFilesResult, SentFile } from "./service-requests"
import type { ServiceCall } from "./service-server"
import type { ResolvedSyncOptions } from "./sync-options"
import { errorLabel } from "./sync-outcome"
import { viaTelegram } from "./sync-request-calls"
import { cancelled } from "./sync-request-errors"
import { parseSendFilesParams } from "./sync-request-params"
import type { RequestQueue } from "./sync-request-queue"
import { handOver, record, replyToOf, transmit, type SendContext, type SendRequest } from "./sync-send"
import { withOutboxFiles } from "./sync-send-outbox"
import { checkSendable, deliveredFileIds, type FileFacts } from "./sync-send-mirror"
import { sentFilesOf, uncertainSend } from "./sync-send-outcome"
import { readFullSent } from "./sync-send-record"
import { documentOf, uploadFiles, uploadedDocumentOf, type UploadContext } from "./sync-send-upload"
import type { SyncTelegram } from "./sync-telegram"

/** What the file send works with; the sync requests' context holds all of it. */
export type SendFilesContext = SendContext &
  UploadContext & {
    client: Pick<SyncTelegram, "uploadFile">
    settings: Pick<ResolvedSyncOptions, "stateDir" | "label">
  }

/** The files of a send once they are on Telegram's servers, ready for the one call that sends them. */
type Prepared = {
  peer: tl.TypeInputPeer
  /** The media of each file, in order: the uploaded file itself for one file, the document `uploadMedia` made of it for a group. */
  media: tl.TypeInputMedia[]
  /** What each file is as the mirror will record it. */
  facts: FileFacts[]
}

/**
 * Checks the files against the outbox, then uploads each in order and, for a
 * group, turns each into a document. Nothing is sent by any of it, so every
 * failure here is one that says nothing was sent. A session found ended ends
 * the run after this handler returns, so that the answer is written before
 * the service closes its sockets.
 */
async function prepare(
  ctx: SendFilesContext,
  call: ServiceCall,
  signal: AbortSignal,
  params: SendFilesParams,
): Promise<Prepared> {
  const { stateDir, label } = ctx.settings
  const stepCtx: SendFilesContext = { ...ctx, endSession: () => void setImmediate(() => ctx.endSession()) }
  return withOutboxFiles(labelPaths(stateDir, label).outbox, params.files, async (files) => {
    const peer = await viaTelegram(stepCtx, call, "send", () => ctx.client.resolvePeer(Number(params.chat)))
    if (signal.aborted) throw cancelled()
    const uploaded = await uploadFiles(stepCtx, signal, files)
    const media: tl.TypeInputMedia[] = []
    if (uploaded.length === 1) media.push(uploadedDocumentOf(uploaded[0]!))
    else for (const file of uploaded) media.push(await documentOf(stepCtx, signal, peer, file))
    return { peer, media, facts: files.map(({ name, size }) => ({ name, size })) }
  })
}

/**
 * The one call that sends the files: `messages.sendMedia` for one, with the
 * caption; `messages.sendMultiMedia` for several, a `random_id` each, with the
 * caption on the last. No entities and no parse mode: the caption goes out as
 * written.
 */
function requestOf(params: SendFilesParams, { peer, media }: Prepared, randomIds: readonly Long[]): SendRequest {
  const replyTo = replyToOf(params)
  const reply = replyTo ? { replyTo } : {}
  if (media.length === 1) {
    return {
      _: "messages.sendMedia",
      peer,
      media: media[0]!,
      message: params.caption ?? "",
      randomId: randomIds[0]!,
      ...reply,
    }
  }
  return {
    _: "messages.sendMultiMedia",
    peer,
    multiMedia: media.map((item, index) => ({
      _: "inputSingleMedia",
      media: item,
      randomId: randomIds[index]!,
      message: index === media.length - 1 ? (params.caption ?? "") : "",
    })),
    ...reply,
  }
}

/** What a `RANDOM_ID_DUPLICATE` answer gives: the ids of the files' messages the mirror has, never the time. */
function duplicateResult(
  ctx: SendFilesContext,
  params: SendFilesParams,
  { facts }: Prepared,
  startedAt: number,
): SendFilesResult {
  let messages: SentFile[] = []
  try {
    messages = deliveredFileIds(ctx.mirror, params.chat, facts, startedAt)
  } catch (error) {
    ctx.settings.log(`send: the mirror could not be searched (${errorLabel(error)})`)
  }
  return messages.length === 0 ? { duplicate: true } : { messages, duplicate: true }
}

/** What an accepted response gives; a response that does not name every file's message leaves the outcome open. */
function acceptedResult(
  ctx: SendFilesContext,
  { facts }: Prepared,
  response: tl.TypeUpdates,
  randomIds: readonly Long[],
): SendFilesResult {
  handOver(ctx, response)
  const sent = sentFilesOf(response, randomIds)
  if (!sent) throw uncertainSend("Telegram's answer did not name every file's message")
  for (const message of sent) {
    if (!record(ctx, () => readFullSent(message, ctx.settings.channels))) break
  }
  return { messages: sent.map(({ id }, index) => ({ id, name: facts[index]!.name })), date: sent[0]!.date }
}

/** Checks the send against the mirror and the outbox, uploads the files, then sends them once. See `sendFilesRequest`. */
async function sendFiles(
  ctx: SendFilesContext,
  call: ServiceCall,
  signal: AbortSignal,
  params: SendFilesParams,
): Promise<SendFilesResult> {
  checkSendable(ctx.mirror, params)
  const prepared = await prepare(ctx, call, signal, params)

  // One for each file, generated once: the call is never repeated by the package, and a delivery mtcute repeats carries the same bytes.
  const randomIds = prepared.media.map(() => randomLong())
  const startedAt = ctx.settings.now()
  const response = await transmit(ctx, signal, requestOf(params, prepared, randomIds))
  return response === undefined
    ? duplicateResult(ctx, params, prepared, startedAt)
    : acceptedResult(ctx, prepared, response, randomIds)
}

/**
 * Answers a `send_files` request: files from the label's `outbox/` sent to a
 * chat the mirror lists as files, in one call with a `random_id` for each, and
 * recorded in the mirror as Telegram returned them. Everything is checked and
 * uploaded first, and fails as `invalid_argument`, `forbidden`, `not_found`
 * or `upstream_error` with nothing sent (see `withOutboxFiles`,
 * `checkSendable` and `uploadFiles`). The outcome of the send is decided as a
 * text's is (see `sendFailureOf`), and it is accepted only when Telegram names
 * every file's message. Sends, of text and of files, run one at a time through
 * `queue`.
 */
export function sendFilesRequest(
  ctx: SendFilesContext,
  queue: RequestQueue,
  raw: unknown,
  call: ServiceCall,
): Promise<SendFilesResult> {
  const params = parseSendFilesParams(raw)
  const signal = AbortSignal.any([call.signal, ctx.signal])
  return queue.run(signal, () => sendFiles(ctx, call, signal, params))
}
