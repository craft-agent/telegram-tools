import { chatFact } from "../chat/facts"
import { mediaKindValue } from "../chat/media-facts"
import { cut, MAX_VALUE_LENGTH } from "../describe"
import type { ChatRow } from "../telegram/mirror-rows"
import type { CallDescription, CallFact, CallHeadline } from "../tool"
import { topicFacts } from "./facts"
import type { ActionMessage } from "./own"

/** The headline templates of an action: for a chat the mirror names, Saved Messages, and a chat without a name. */
export type ActionHeadlines = { named: string; saved: string; bare: string }

/** The headlines of an edit. */
export const EDIT_HEADLINES: ActionHeadlines = {
  named: "About to edit message {id} in {chat}",
  saved: "About to edit message {id} in Saved Messages",
  bare: "About to edit message {id}",
}

/** The headlines of a delete. */
export const DELETE_HEADLINES: ActionHeadlines = {
  named: "About to delete message {id} from {chat} for everyone",
  saved: "About to delete message {id} from Saved Messages",
  bare: "About to delete message {id} for everyone",
}

/** The headlines of a reaction set. */
export const REACT_HEADLINES: ActionHeadlines = {
  named: "About to react {emoji} to message {id} in {chat}",
  saved: "About to react {emoji} to message {id} in Saved Messages",
  bare: "About to react {emoji} to message {id}",
}

/** The headlines of a reaction removed. */
export const UNREACT_HEADLINES: ActionHeadlines = {
  named: "About to remove your reaction from message {id} in {chat}",
  saved: "About to remove your reaction from message {id} in Saved Messages",
  bare: "About to remove your reaction from message {id}",
}

/** The headlines of a pin. */
export const PIN_HEADLINES: ActionHeadlines = {
  named: "About to pin message {id} in {chat}",
  saved: "About to pin message {id} in Saved Messages",
  bare: "About to pin message {id}",
}

/** The headlines of an unpin. */
export const UNPIN_HEADLINES: ActionHeadlines = {
  named: "About to unpin message {id} in {chat}",
  saved: "About to unpin message {id} in Saved Messages",
  bare: "About to unpin message {id}",
}

/** The headlines of a read mark; `{id}` is the message it reaches. */
export const MARK_READ_HEADLINES: ActionHeadlines = {
  named: "About to mark {chat} read up to message {id}",
  saved: "About to mark Saved Messages read up to message {id}",
  bare: "About to mark messages read up to message {id}",
}

/** What an action adds to the description beside the chat, the message and its text: the values its headline template holds besides `id` and `chat`, facts after `Current` or `Media`, and pins beside the last edit. */
export type ActionExtras = {
  values?: Record<string, string>
  facts?: CallFact[]
  pins?: Record<string, string>
}

/** The headline of an action: the chat's name from the mirror, Saved Messages for the user's own chat, or no chat name when it has none. */
function actionHeadline(
  headlines: ActionHeadlines,
  { kind, name }: Pick<ChatRow, "kind" | "name">,
  id: number,
  values: Record<string, string>,
): CallHeadline {
  if (kind === "self") return { text: headlines.saved, values: { id: String(id), ...values } }
  return name === null
    ? { text: headlines.bare, values: { id: String(id), ...values } }
    : { text: headlines.named, values: { id: String(id), chat: name, ...values } }
}

/** The `Current` fact: the message's text or caption, cut to the budget of a fact's value; else `Media` for its media kind, or none for a message with neither. */
function currentFacts({ body, media }: ActionMessage): CallFact[] {
  if (body) return [{ label: "Current", value: cut(body, MAX_VALUE_LENGTH) }]
  return media ? [{ label: "Media", value: mediaKindValue(media.type) }] : []
}

/**
 * What an action on a message says of itself for the approval prompt: the
 * chat's kind, the message and, when the mirror holds it, its text now (or
 * the kind of its media), then what the action `extras` add. The pin is when the message was last edited
 * (else sent), so a message edited after the prompt stops the call as
 * `stale`. `message` is null for a message the mirror has as deleted, which
 * has nothing to show or to pin.
 */
export function describeAction(
  headlines: ActionHeadlines,
  chat: Pick<ChatRow, "kind" | "name">,
  id: number,
  message: ActionMessage | null,
  extras: ActionExtras = {},
): CallDescription {
  const headline = actionHeadline(headlines, chat, id, extras.values ?? {})
  return {
    ...(headline && { headline }),
    facts: [
      chatFact(chat.kind),
      { label: "Message", value: { text: "message {id}", values: { id } } },
      ...(message ? currentFacts(message) : []),
      ...(extras.facts ?? []),
    ],
    ...(message && { pins: { edited: String(message.edited ?? message.ts), ...extras.pins } }),
  }
}

/**
 * What a read mark says of itself for the approval prompt: the chat's kind, the
 * topic when the call names one (its title in the mirror, else its id), and
 * the message it reaches. It says no count of what becomes read, since that
 * grows while the service syncs, and pins nothing: the call neither changes a
 * message nor depends on one's text.
 */
export function describeMarkRead(
  chat: Pick<ChatRow, "kind" | "name">,
  upTo: number,
  topic: { id: number | undefined; title: string | undefined },
): CallDescription {
  const headline = actionHeadline(MARK_READ_HEADLINES, chat, upTo, {})
  return {
    ...(headline && { headline }),
    facts: [
      chatFact(chat.kind),
      ...topicFacts(topic.id, topic.title),
      { label: "Up to", value: { text: "message {id}", values: { id: upTo } } },
    ],
  }
}
