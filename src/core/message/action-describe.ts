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

/** The headline of an action: the chat's name from the mirror, or Saved Messages for the user's own chat; none for a chat without a name, so the intent stands. */
function actionHeadline(
  headlines: ActionHeadlines,
  { kind, name }: Pick<ChatRow, "kind" | "name">,
  id: number,
): CallHeadline | undefined {
  if (kind === "self") return { text: headlines.saved, values: { id: String(id) } }
  return name === null ? undefined : { text: headlines.named, values: { id: String(id), chat: name } }
}

/** The `Current` fact: the message's text now, or its caption, or the kind of its media when it has no caption, cut to the budget of a fact's value; none for a message with neither. */
function currentFacts({ body, media }: OwnMessage): CallFact[] {
  const shown = body || media?.type
  return shown ? [{ label: "Current", value: cut(shown, MAX_VALUE_LENGTH) }] : []
}

/**
 * What an action on the user's own message says of itself for the approval
 * prompt: the chat's kind, the message and, when the mirror holds it, its text
 * now. The pin is when the message was last edited (else sent), so a message
 * edited after the prompt stops the call as `stale`. `message` is null for a
 * message the mirror has as deleted, which has nothing to show or to pin.
 */
export function describeAction(
  headlines: ActionHeadlines,
  chat: Pick<ChatRow, "kind" | "name">,
  id: number,
  message: OwnMessage | null,
): CallDescription {
  const headline = actionHeadline(headlines, chat, id)
  return {
    ...(headline && { headline }),
    facts: [
      chatFact(chat.kind),
      { label: "Message", value: { text: "message {id}", values: { id } } },
      ...(message ? currentFacts(message) : []),
    ],
    ...(message && { pins: { edited: String(message.edited ?? message.ts) } }),
  }
}
