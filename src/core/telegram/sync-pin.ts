import { Message, PeersIndex, type tl } from "@mtcute/core"
import { ACTION_PAST, checkBothSides, isPrivateChat } from "./action-checks"
import type { PinParams, PinResult } from "./service-requests"
import type { ServiceCall } from "./service-server"
import { performAction, recordAction, resolveChatPeer, runAction, type ActionContext } from "./sync-action"
import { anyMessageOf } from "./sync-action-mirror"
import { MESSAGE_GONE, type ActionRefusals, type ActionWords } from "./sync-action-outcome"
import { parsePinParams } from "./sync-request-params"
import type { RequestQueue } from "./sync-request-queue"
import { handOver } from "./sync-send"
import { readMessage } from "./sync-message"
import { recordSent } from "./sync-send-record"

const PIN_WORDS: ActionWords = {
  name: "pin",
  gerund: "pinning",
  past: ACTION_PAST.pin,
  untouched: "the pin is unchanged",
}

const UNPIN_WORDS: ActionWords = {
  name: "unpin",
  gerund: "unpinning",
  past: ACTION_PAST.unpin,
  untouched: "the pin is unchanged",
}

/**
 * How a failed pin or unpin, told in `words`, is answered. `CHAT_NOT_MODIFIED`
 * is the message already being pinned, or not pinned, as asked.
 */
function pinRefusals(words: ActionWords): ActionRefusals {
  return {
    words,
    already: ["CHAT_NOT_MODIFIED"],
    named: [
      MESSAGE_GONE,
      { names: ["PIN_RESTRICTED"], code: "forbidden", what: "Telegram does not let this account pin messages here" },
      { names: ["PINNED_TOO_MUCH"], code: "forbidden", what: "Telegram allows no more pinned messages in this chat" },
      {
        names: ["BOT_ONESIDE_NOT_AVAIL"],
        code: "forbidden",
        what: "Telegram takes no one-sided pin in a chat with a bot; ask for both sides",
      },
    ],
  }
}

const PIN_REFUSALS = pinRefusals(PIN_WORDS)
const UNPIN_REFUSALS = pinRefusals(UNPIN_WORDS)

/**
 * Records the service messages an answer carries for `chat`, such as the one a
 * pin that tells the members makes, the way a sent message is: they are the
 * user's own. A message that is not for the mirror, or is another chat's, is
 * left out.
 */
function recordServiceMessages(ctx: ActionContext, chat: string, response: tl.TypeUpdates): void {
  if (response._ !== "updates" && response._ !== "updatesCombined") return
  recordAction(ctx, "pin", () => {
    const { channels, keepDisappearing, now } = ctx.settings
    for (const update of response.updates) {
      if (update._ !== "updateNewMessage" && update._ !== "updateNewChannelMessage") continue
      if (update.message._ !== "messageService") continue
      const read = readMessage(new Message(update.message, PeersIndex.from(response)), channels)
      if (read?.message.chat === chat) recordSent(ctx.mirror, { now: now(), keepDisappearing }, read, channels)
    }
  })
}

/** Checks the pin against the mirror, then asks for it once. See `pinRequest`. */
async function pinMessage(
  ctx: ActionContext,
  call: ServiceCall,
  signal: AbortSignal,
  params: PinParams,
): Promise<PinResult> {
  const unpin = params.unpin === true
  const { chat } = anyMessageOf(ctx.mirror, params.chat, params.id, unpin ? UNPIN_WORDS : PIN_WORDS)
  checkBothSides(chat.kind, params.both_sides)
  const peer = await resolveChatPeer(ctx, call, signal, "pin", params.chat)

  // Silent unless asked to notify, and in a private chat for the user only unless asked for both sides; a flag that is off is left out.
  const request: tl.messages.RawUpdatePinnedMessageRequest = {
    _: "messages.updatePinnedMessage",
    peer,
    id: params.id,
    ...(params.notify ? {} : { silent: true }),
    ...(unpin ? { unpin } : {}),
    ...(isPrivateChat(chat.kind) && !params.both_sides ? { pmOneside: true } : {}),
  }
  const response = await performAction(ctx, signal, unpin ? UNPIN_REFUSALS : PIN_REFUSALS, request)
  if (response === undefined) return { id: params.id, pinned: !unpin, already: true }
  handOver(ctx, response, "pin")
  recordServiceMessages(ctx, params.chat, response)
  return { id: params.id, pinned: !unpin }
}

/**
 * Answers a `pin` request: a message of any author, in a chat the mirror
 * lists, pinned or unpinned through one low-level call. Checked against the
 * mirror first, and failing as `forbidden`, `invalid_argument` or `not_found`
 * with nothing changed (see `targetOf` and `checkBothSides`). A pin is silent
 * and, in a private chat, one-sided unless the call asks otherwise. Whether a
 * message is pinned is not mirrored; only the service message a pin makes is
 * recorded. The outcome is never guessed: see `actionFailureOf`. Pins run one
 * at a time through `queue`, which the sends share.
 */
export function pinRequest(
  ctx: ActionContext,
  queue: RequestQueue,
  raw: unknown,
  call: ServiceCall,
): Promise<PinResult> {
  return runAction(ctx, queue, raw, call, parsePinParams, (params, signal) => pinMessage(ctx, call, signal, params))
}
