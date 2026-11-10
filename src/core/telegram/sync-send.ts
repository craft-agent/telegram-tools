import type { ConnectionState, Long, RpcCallOptions, tl } from "@mtcute/core"
import { randomLong } from "@mtcute/core/utils.js"
import { ToolError } from "../errors"
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
import { isRandomIdDuplicate, sendFailureOf, sentMessageOf, uncertainSend, type SendTrouble } from "./sync-send-outcome"
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
 * `random_id`; that is what `RANDOM_ID_DUPLICATE` answers. An action has no
 * `random_id`, and its repeat is told by the state it asks for.
 */
const ONE_CALL_OPTIONS = { maxRetryCount: 0, floodSleepThreshold: 0 } as const

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
 * Makes the one call that `call` starts and resolves with Telegram's answer.
 * A failure goes to `settle`, with the connection states seen while the call
 * was out: anything but `connected` marks a reconnect. `settle` returns the
 * answer to stand for the failure (the failure proves the call landed), or the
 * error to throw, which is logged as `<what> failed` and, for a session that
 * ended, ends the run. A session reset that brings no state change cannot be
 * seen, so a refusal that answers such a repeat reads as a first answer.
 */
export async function callOnce<Answer>(
  ctx: SendContext,
  signal: AbortSignal,
  what: string,
  call: (options: RpcCallOptions) => Promise<Answer>,
  settle: (error: unknown, trouble: SendTrouble) => Answer | ToolError,
): Promise<Answer> {
  let reconnected = false
  const onState = (state: ConnectionState) => {
    if (state !== "connected") reconnected = true
  }
  ctx.client.onConnectionState.add(onState)
  try {
    return await untilAborted(call({ ...ONE_CALL_OPTIONS, abortSignal: signal }), signal)
  } catch (error) {
    const settled = settle(error, { reconnected, aborted: signal.aborted })
    if (!(settled instanceof ToolError)) return settled
    if (isSessionEnded(error)) ctx.endSession()
    ctx.settings.log(`${what} failed: ${errorLabel(error)}`)
    throw settled
  } finally {
    ctx.client.onConnectionState.remove(onState)
  }
}

/**
 * Makes the one call of a send and resolves with Telegram's response, or with
 * undefined when Telegram answers `RANDOM_ID_DUPLICATE`. Any other failure
 * throws what `sendFailureOf` decides (see `callOnce`).
 */
export function transmit(
  ctx: SendContext,
  signal: AbortSignal,
  request: SendRequest,
): Promise<tl.TypeUpdates | undefined> {
  return callOnce<tl.TypeUpdates | undefined>(
    ctx,
    signal,
    "send",
    (options) => ctx.client.call(request, options),
    (error, trouble) => (isRandomIdDuplicate(error) ? undefined : sendFailureOf(error, trouble)),
  )
}

/**
 * Tells mtcute's update state about the response, as its own text sender does,
 * so that the state stays consistent. `what` names the request in the log.
 */
export function handOver(ctx: SendContext, response: tl.TypeUpdates, what = "send"): void {
  try {
    if (response._ !== "updateShortSentMessage") {
      ctx.client.handleClientUpdate(response, true)
      return
    }
    handOverPts(ctx, response)
  } catch (error) {
    ctx.settings.log(`${what}: the update state could not take the response (${errorLabel(error)})`)
  }
}

/**
 * Tells mtcute's update state of events the response counted but did not
 * carry, with a dummy update that moves nothing else. `channelId` is the bare
 * id of the channel whose events they are; 0 for the account's own.
 */
export function handOverPts(
  ctx: SendContext,
  { pts, ptsCount }: { pts: number; ptsCount: number },
  channelId = 0,
): void {
  const dummy: tl.mtcute.RawDummyUpdate = { _: "mtcute.dummyUpdate", channelId, pts, ptsCount }
  ctx.client.handleClientUpdate({ _: "updates", seq: 0, date: 0, chats: [], users: [], updates: [dummy] })
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
      // The call's context holds the run's end back until the answer has been written.
      ctx.failRun(error)
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
