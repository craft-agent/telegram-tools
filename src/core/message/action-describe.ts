import { chatFact } from "../chat/facts"
import { cut, MAX_VALUE_LENGTH } from "../describe"
import type { ChatRow } from "../telegram/mirror-rows"
import type { CallDescription, CallFact, CallHeadline } from "../tool"
import type { OwnMessage } from "./own"

/** The headline templates of an action: for a chat the mirror names, and for Saved Messages. */
export type ActionHeadlines = { named: string; saved: string }

/** The headlines of an edit. */
export const EDIT_HEADLINES: ActionHeadlines = {
  named: "About to edit message {id} in {chat}",
  saved: "About to edit message {id} in Saved Messages",
}

/** The headlines of a delete. */
export const DELETE_HEADLINES: ActionHeadlines = {
  named: "About to delete message {id} from {chat}",
  saved: "About to delete message {id} from Saved Messages",
}

/** The headlines of a reaction set. */
export const REACT_HEADLINES: ActionHeadlines = {
  named: "About to react {emoji} to message {id} in {chat}",
  saved: "About to react {emoji} to message {id} in Saved Messages",
}

/** The headlines of a reaction removed. */
export const UNREACT_HEADLINES: ActionHeadlines = {
  named: "About to remove your reaction from message {id} in {chat}",
  saved: "About to remove your reaction from message {id} in Saved Messages",
}

/** The headlines of a pin. */
export const PIN_HEADLINES: ActionHeadlines = {
  named: "About to pin message {id} in {chat}",
  saved: "About to pin message {id} in Saved Messages",
}

/** The headlines of an unpin. */
export const UNPIN_HEADLINES: ActionHeadlines = {
  named: "About to unpin message {id} in {chat}",
  saved: "About to unpin message {id} in Saved Messages",
}

/** What an action adds to the description beside the chat, the message and its text: the values its headline template holds besides `id` and `chat`, facts after `Current`, and pins beside the last edit. */
export type ActionExtras = {
  values?: Record<string, string>
  facts?: CallFact[]
  pins?: Record<string, string>
}

/** The headline of an action: the chat's name from the mirror, or Saved Messages for the user's own chat; none for a chat without a name, so the intent stands. */
function actionHeadline(
  headlines: ActionHeadlines,
  { kind, name }: Pick<ChatRow, "kind" | "name">,
  id: number,
  values: Record<string, string>,
): CallHeadline | undefined {
  if (kind === "self") return { text: headlines.saved, values: { id: String(id), ...values } }
  return name === null ? undefined : { text: headlines.named, values: { id: String(id), chat: name, ...values } }
}

/** The `Current` fact: the message's text now, or its caption, or the kind of its media when it has no caption, cut to the budget of a fact's value; none for a message with neither. */
function currentFacts({ body, media }: OwnMessage): CallFact[] {
  const shown = body || media?.type
  return shown ? [{ label: "Current", value: cut(shown, MAX_VALUE_LENGTH) }] : []
}

/**
 * What an action on a message says of itself for the approval prompt: the
 * chat's kind, the message and, when the mirror holds it, its text now, then
 * what the action `extras` add. The pin is when the message was last edited
 * (else sent), so a message edited after the prompt stops the call as
 * `stale`. `message` is null for a message the mirror has as deleted, which
 * has nothing to show or to pin.
 */
export function describeAction(
  headlines: ActionHeadlines,
  chat: Pick<ChatRow, "kind" | "name">,
  id: number,
  message: OwnMessage | null,
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
