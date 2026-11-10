import { setImmediate } from "node:timers"
import type { ConnectionState, Long, tl } from "@mtcute/core"
import { randomLong } from "@mtcute/core/utils.js"
import type { Mirror } from "./mirror"
import { isSessionEnded } from "./rpc-errors"
import { GENERAL_TOPIC, type SendParams, type SendResult } from "./service-requests"
import type { ServiceCall } from "./service-server"
import type { ResolvedSyncOptions } from "./sync-options"
import { errorLabel } from "./sync-outcome"
import { viaTelegram, type TelegramCallContext } from "./sync-request-calls"
import { cancelled } from "./sync-request-errors"
import { parseSendParams } from "./sync-request-params"
import { StorageFailure } from "./sync-ending"
import type { RequestQueue } from "./sync-request-queue"
import { checkSendable, deliveredId } from "./sync-send-mirror"
import { isRandomIdDuplicate, sendFailureOf, sentMessageOf, uncertainSend } from "./sync-send-outcome"
import { readSent, recordSent } from "./sync-send-record"
import type { ReadMessage } from "./sync-message"
import type { SyncTelegram } from "./sync-telegram"
import { onAbort } from "./sync-wait"

/** What the send request works with; the sync requests' context holds all of it. */
export type SendContext = TelegramCallContext & {
  client: Pick<SyncTelegram, "resolvePeer" | "call" | "handleClientUpdate" | "onConnectionState">
  mirror: Mirror
  settings: Pick<ResolvedSyncOptions, "log" | "now" | "channels" | "keepDisappearing">
  /** Ends the run for a failure of the service's own, such as a mirror that cannot be written. */
  failRun(error: unknown): void
}

/**
 * The options of the one call: no retry and no sleeping through a flood wait,
 * since either would repeat it. mtcute still delivers a call again after a
 * reconnect or a session reset, with the same bytes and so the same
 * `random_id`; that is what `RANDOM_ID_DUPLICATE` answers.
 */
const SEND_CALL_OPTIONS = { maxRetryCount: 0, floodSleepThreshold: 0 } as const

/** The calls a send makes: one text, one file, or a group of files. */
export type SendRequest =
  tl.messages.RawSendMessageRequest | tl.messages.RawSendMediaRequest | tl.messages.RawSendMultiMediaRequest

/** The reply header of a send: the message replied to, in the topic. The General topic is no topic to Telegram's header. */
export function replyToOf({
  topic,
  reply_to,
}: Pick<SendParams, "topic" | "reply_to">): tl.TypeInputReplyTo | undefined {
  const inTopic = topic === GENERAL_TOPIC ? undefined : topic
  const replyToMsgId = reply_to ?? inTopic
  if (replyToMsgId === undefined) return undefined
  return { _: "inputReplyToMessage", replyToMsgId, ...(inTopic === undefined ? {} : { topMsgId: inTopic }) }
}

/** `promise`, rejecting with the abort reason the moment `signal` aborts; what the promise does later is ignored. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stopListening = onAbort(signal, () => reject(signal.reason))
    promise.then(resolve, reject).then(stopListening)
  })
}

/**
 * Makes the one call and resolves with Telegram's response, or with undefined
 * when Telegram answers `RANDOM_ID_DUPLICATE`. Any other failure throws what
 * `sendFailureOf` decides, with the connection states seen while the call was
 * out: anything but `connected` marks a reconnect. A session reset that
 * brings no state change cannot be seen, so a refusal that answers such a
 * repeat reads as a first answer.
 */
export async function transmit(
  ctx: SendContext,
  signal: AbortSignal,
  request: SendRequest,
): Promise<tl.TypeUpdates | undefined> {
  let reconnected = false
  const onState = (state: ConnectionState) => {
    if (state !== "connected") reconnected = true
  }
  ctx.client.onConnectionState.add(onState)
  try {
    return await untilAborted(ctx.client.call(request, { ...SEND_CALL_OPTIONS, abortSignal: signal }), signal)
  } catch (error) {
    if (isRandomIdDuplicate(error)) return undefined
    if (isSessionEnded(error)) ctx.endSession()
    ctx.settings.log(`send failed: ${errorLabel(error)}`)
    throw sendFailureOf(error, { reconnected, aborted: signal.aborted })
  } finally {
    ctx.client.onConnectionState.remove(onState)
  }
}

/** Tells mtcute's update state about the response, as its own text sender does, so that the state stays consistent. */
export function handOver(ctx: SendContext, response: tl.TypeUpdates): void {
  try {
    if (response._ !== "updateShortSentMessage") {
      ctx.client.handleClientUpdate(response, true)
      return
    }
    const { pts, ptsCount } = response
    const dummy: tl.mtcute.RawDummyUpdate = { _: "mtcute.dummyUpdate", channelId: 0, pts, ptsCount }
    ctx.client.handleClientUpdate({ _: "updates", seq: 0, date: 0, chats: [], users: [], updates: [dummy] })
  } catch (error) {
    ctx.settings.log(`send: the update state could not take the response (${errorLabel(error)})`)
  }
}

/**
 * Records the sent message `read` gives in the mirror. It never fails the
 * send, which went out: a message that cannot be read is left for the gap
 * filling to bring, and a mirror that cannot be written stops the service, as
 * it does for a received message, once the answer has been written. False
 * when the mirror cannot be written, so that nothing more is recorded.
 */
export function record(ctx: SendContext, read: () => ReadMessage | null): boolean {
  const { mirror, settings } = ctx
  try {
    const message = read()
    if (!message) return true
    recordSent(mirror, { now: settings.now(), keepDisappearing: settings.keepDisappearing }, message, settings.channels)
  } catch (error) {
    if (error instanceof StorageFailure) {
      // After this handler returns, so that the answer is written before the service closes its sockets.
      setImmediate(() => ctx.failRun(error))
      return false
    }
    settings.log(`send: the sent message could not be read (${errorLabel(error)})`)
  }
  return true
}

/** What a `RANDOM_ID_DUPLICATE` answer gives: the message's id when the mirror has it, never the time. */
function duplicateResult(ctx: SendContext, params: SendParams, startedAt: number): SendResult {
  let id: number | undefined
  try {
    id = deliveredId(ctx.mirror, params.chat, params.text, startedAt)
  } catch (error) {
    ctx.settings.log(`send: the mirror could not be searched (${errorLabel(error)})`)
  }
  return id === undefined ? { duplicate: true } : { id, duplicate: true }
}

/** What an accepted response gives; a response without our message leaves the outcome open. */
function acceptedResult(ctx: SendContext, params: SendParams, response: tl.TypeUpdates, randomId: Long): SendResult {
  handOver(ctx, response)
  const sent = sentMessageOf(response, randomId)
  if (!sent) throw uncertainSend("Telegram's answer did not name the message")
  record(ctx, () => readSent(sent, params, ctx.settings.channels))
  return { id: sent.id, date: sent.date }
}

/** Checks the send against the mirror, then sends it once. See `sendRequest`. */
async function sendText(
  ctx: SendContext,
  call: ServiceCall,
  signal: AbortSignal,
  params: SendParams,
): Promise<SendResult> {
  checkSendable(ctx.mirror, params)
  const peer = await viaTelegram(ctx, call, "send", () => ctx.client.resolvePeer(Number(params.chat)))
  if (signal.aborted) throw cancelled()

  // Generated once: the call is never repeated by the package, and a delivery mtcute repeats carries the same bytes.
  const randomId = randomLong()
  const replyTo = replyToOf(params)
  const request: tl.messages.RawSendMessageRequest = {
    _: "messages.sendMessage",
    peer,
    message: params.text,
    randomId,
    ...(replyTo ? { replyTo } : {}),
  }
  const startedAt = ctx.settings.now()
  const response = await transmit(ctx, signal, request)
  return response === undefined
    ? duplicateResult(ctx, params, startedAt)
    : acceptedResult(ctx, params, response, randomId)
}

/**
 * Answers a `send` request: one text to a chat the mirror lists, sent through
 * one low-level call with one `random_id`, and recorded in the mirror as
 * Telegram returned it. Checked against the mirror first, and failing as
 * `forbidden`, `invalid_argument` or `not_found` with nothing sent (see
 * `checkSendable`). The outcome is never guessed: see `sendFailureOf`, which
 * leaves `uncertain` everything that may have gone out. Sends run one at a
 * time through `queue`, which nothing else shares.
 */
export function sendRequest(
  ctx: SendContext,
  queue: RequestQueue,
  raw: unknown,
  call: ServiceCall,
): Promise<SendResult> {
  const params = parseSendParams(raw)
  const signal = AbortSignal.any([call.signal, ctx.signal])
  return queue.run(signal, () => sendText(ctx, call, signal, params))
}
