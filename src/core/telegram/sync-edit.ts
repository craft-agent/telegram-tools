import { Message, PeersIndex, type tl } from "@mtcute/core"
import { ACTION_PAST, checkEditable, deletedMessage, takesCaption } from "./action-checks"
import type { MediaInfo } from "./mirror-input"
import type { EditParams, EditResult } from "./service-requests"
import type { ServiceCall } from "./service-server"
import { performAction, recordAction, type ActionContext } from "./sync-action"
import { storedMessageOf, targetOf, type ActionTarget } from "./sync-action-mirror"
import { MESSAGE_GONE, uncertainAction, type ActionRefusals, type ActionWords } from "./sync-action-outcome"
import { errorLabel } from "./sync-outcome"
import { viaTelegram } from "./sync-request-calls"
import { cancelled } from "./sync-request-errors"
import { parseEditParams } from "./sync-request-params"
import type { RequestQueue } from "./sync-request-queue"
import { handOver } from "./sync-send"
import { readMessage } from "./sync-message"
import { recordSent } from "./sync-send-record"

const MS_PER_S = 1000

const EDIT_WORDS: ActionWords = {
  name: "edit",
  gerund: "editing",
  past: ACTION_PAST.edit,
  untouched: "the message is unchanged",
}

/**
 * How a failed edit is told. `MESSAGE_NOT_MODIFIED` is the message already
 * having the text: the pre-check ruled out asking for what the mirror shows,
 * so it means an earlier delivery of this call landed.
 */
const EDIT_REFUSALS: ActionRefusals = {
  words: EDIT_WORDS,
  already: ["MESSAGE_NOT_MODIFIED"],
  named: [
    MESSAGE_GONE,
    { names: ["MESSAGE_EDIT_TIME_EXPIRED"], code: "forbidden", what: "Telegram no longer lets this message be edited" },
    { names: ["MESSAGE_AUTHOR_REQUIRED"], code: "forbidden", what: "Telegram lets only its author edit this message" },
    {
      names: ["EDIT_MESSAGE_TEMP_RESTRICTED"],
      code: "forbidden",
      what: "Telegram is not letting this account edit messages for now",
    },
    { names: ["MESSAGE_TOO_LONG", "MESSAGE_EMPTY"], code: "invalid_argument", what: "Telegram refused the text" },
    { names: ["MEDIA_CAPTION_TOO_LONG"], code: "invalid_argument", what: "Telegram refused the caption" },
  ],
}

/**
 * Refuses an edit that the mirror shows cannot succeed, before anything is
 * sent (see `deletedMessage` and `checkEditable`).
 */
function refuseUneditable({ message }: ActionTarget, text: string): void {
  if (!message) throw deletedMessage()
  // The stored media is JSON; a link preview is part of a text, not media a caption goes with.
  const captioned = message.media !== null && takesCaption((JSON.parse(message.media) as Pick<MediaInfo, "type">).type)
  checkEditable({ ...message, captioned }, text)
}

/** The edited message `id` of an updates group, as Telegram numbers it; undefined when the group does not hold it. */
function editedOf(group: tl.RawUpdates | tl.RawUpdatesCombined, id: number): tl.RawMessage | undefined {
  for (const update of group.updates) {
    if (update._ !== "updateEditMessage" && update._ !== "updateEditChannelMessage") continue
    if (update.message._ === "message" && update.message.id === id) return update.message
  }
  return undefined
}

/**
 * Records the edited message the way a pushed edit is, so that the version it
 * replaced goes to `edits`. A message that is not for the mirror, or is
 * another chat's, is left out.
 */
function recordEdit(
  ctx: ActionContext,
  { chat }: EditParams,
  raw: tl.RawMessage,
  group: tl.RawUpdates | tl.RawUpdatesCombined,
): void {
  recordAction(ctx, "edit", () => {
    const { channels, keepDisappearing, now } = ctx.settings
    const read = readMessage(new Message(raw, PeersIndex.from(group)), channels)
    if (read?.message.chat !== chat) return
    recordSent(ctx.mirror, { now: now(), keepDisappearing }, read, channels)
  })
}

/**
 * What a message that already has the text gives: its id, and the time of its
 * edit only when the mirror has the message with this text by now (an update
 * of the earlier delivery came first), since the time of an older edit would
 * be wrong.
 */
function alreadyResult(ctx: ActionContext, { chat, id, text }: EditParams): EditResult {
  try {
    const stored = storedMessageOf(ctx.mirror, chat, id)
    if (stored?.body === text && stored.edited !== null) return { id, edited: stored.edited, already: true }
  } catch (error) {
    ctx.settings.log(`edit: the mirror could not be read (${errorLabel(error)})`)
  }
  return { id, already: true }
}

/** What an accepted response gives; a response without the edited message leaves the outcome open. */
function acceptedResult(ctx: ActionContext, params: EditParams, response: tl.TypeUpdates): EditResult {
  handOver(ctx, response, "edit")
  const group = response._ === "updates" || response._ === "updatesCombined" ? response : undefined
  const raw = group && editedOf(group, params.id)
  if (!group || raw?.editDate === undefined) {
    throw uncertainAction(EDIT_WORDS, "Telegram's answer did not name the edited message")
  }
  recordEdit(ctx, params, raw, group)
  return { id: params.id, edited: raw.editDate * MS_PER_S }
}

/** Checks the edit against the mirror, then asks for it once. See `editRequest`. */
async function editText(
  ctx: ActionContext,
  call: ServiceCall,
  signal: AbortSignal,
  params: EditParams,
): Promise<EditResult> {
  refuseUneditable(targetOf(ctx.mirror, params.chat, params.id, EDIT_WORDS), params.text)
  const peer = await viaTelegram(ctx, call, "edit", () => ctx.client.resolvePeer(Number(params.chat)))
  if (signal.aborted) throw cancelled()

  // As a send does: no entities, no Markdown and `noWebpage` unset, so the text goes out as written with Telegram's own preview.
  const request: tl.messages.RawEditMessageRequest = {
    _: "messages.editMessage",
    peer,
    id: params.id,
    message: params.text,
  }
  const response = await performAction(ctx, signal, EDIT_REFUSALS, (options) => ctx.client.call(request, options))
  return response === undefined ? alreadyResult(ctx, params) : acceptedResult(ctx, params, response)
}

/**
 * Answers an `edit` request: the text, or the caption, of one of the user's
 * own messages in a chat the mirror lists, replaced through one low-level call
 * and recorded in the mirror as Telegram returned it, which keeps the earlier
 * version. Checked against the mirror first, and failing as `forbidden`,
 * `invalid_argument` or `not_found` with nothing changed (see `targetOf` and
 * `checkEditable`). The outcome is never guessed: see `actionFailureOf`, which
 * leaves `uncertain` everything that may have gone through. Edits run one at
 * a time through `queue`, which the sends share.
 */
export function editRequest(
  ctx: ActionContext,
  queue: RequestQueue,
  raw: unknown,
  call: ServiceCall,
): Promise<EditResult> {
  const params = parseEditParams(raw)
  const signal = AbortSignal.any([call.signal, ctx.signal])
  return queue.run(signal, () => editText(ctx, call, signal, params))
}
