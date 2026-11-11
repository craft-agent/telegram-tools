import { existingChat, messageMedia } from "../chat/chat-rows"
import {
  ACTION_PAST,
  goneMessage,
  isOwnMessage,
  leftChat,
  noSuchMessage,
  notOwnMessage,
  storedReactions,
} from "../telegram/action-checks"
import type { Mirror } from "../telegram/mirror"
import type { MediaInfo, ReactionInfo } from "../telegram/mirror-input"
import { isDeleted, type ChatRow } from "../telegram/mirror-rows"

/** What the user does to a message of their own, for the words of a refusal. */
export type OwnAction = Extract<keyof typeof ACTION_PAST, "edit" | "delete">

/** What the user does to a message of anyone's, for the words of a refusal. */
export type AnyAction = Exclude<keyof typeof ACTION_PAST, OwnAction>

/** What an action needs to know of the message it is aimed at in the mirror. */
export type OwnMessage = {
  /** When it was sent, in milliseconds. */
  ts: number
  kind: "message" | "service"
  /** The text, or the caption of media. */
  body: string | null
  media: MediaInfo | null
  /** When it was last edited, in milliseconds; null for a message never edited. */
  edited: number | null
  /** The reactions it has, as the mirror keeps them; none for a message without. */
  reactions: ReactionInfo[]
  /** The forum topic it is in; null for a message of the General topic or of a chat without topics. */
  topic: number | null
}

/** The chat an action is aimed at, and its message: null when the mirror was told the message is deleted. */
export type OwnTarget = { chat: ChatRow; message: OwnMessage | null }

/** The chat an action is aimed at, and its message, which the mirror holds and has not been told is deleted. */
export type LiveTarget = { chat: ChatRow; message: OwnMessage }

type StoredOwn = {
  ts: number
  from_me: number
  kind: OwnMessage["kind"]
  body: string | null
  reactions: string | null
  topic: number | null
}

/**
 * The chat and the message an action is aimed at, as the sync service checks
 * them before it asks Telegram, so that a call it would refuse is refused here
 * without a request. The chat must be one the mirror has (`not_found`) and the
 * account must not have left it (`forbidden`). With `whose` `own` the message
 * must be the user's own (`forbidden`); `anyone` takes any author's. The
 * message must be one the mirror holds: a message it has as deleted gives a
 * null `message`, and any other missing one is `not_found`, since a chat the
 * mirror does not keep holds no messages to check.
 */
function findMessage(mirror: Mirror, chatId: string, id: number, past: string, whose: "own" | "anyone"): OwnTarget {
  const chat = existingChat(mirror, chatId)
  if (chat.left) throw leftChat(past)
  const row = mirror
    .prepare("SELECT ts, from_me, kind, body, reactions, topic FROM messages WHERE chat = ? AND id = ?")
    .get(chatId, id) as StoredOwn | undefined
  if (!row) {
    if (isDeleted(mirror, chat, id)) return { chat, message: null }
    throw noSuchMessage(id, chat.followed, past)
  }
  if (whose === "own" && !isOwnMessage(row.from_me, chat.kind)) throw notOwnMessage(past)
  const { media, edited } = messageMedia(mirror, chatId, id)!
  const { ts, kind, body, topic } = row
  return { chat, message: { ts, kind, body, media, edited, reactions: storedReactions(row.reactions), topic } }
}

/** The chat and the user's own message an edit or a delete is aimed at; see `findMessage` for what is refused. */
export function findOwnMessage(mirror: Mirror, chatId: string, id: number, action: OwnAction): OwnTarget {
  return findMessage(mirror, chatId, id, ACTION_PAST[action], "own")
}

/**
 * The chat and a message of any author a reaction or a pin is aimed at; see
 * `findMessage` for what is refused. A message the mirror has as deleted is
 * `not_found` too, since an action on it cannot succeed.
 */
export function findAnyMessage(mirror: Mirror, chatId: string, id: number, action: AnyAction): LiveTarget {
  const past = ACTION_PAST[action]
  const { chat, message } = findMessage(mirror, chatId, id, past, "anyone")
  if (!message) throw goneMessage(past)
  return { chat, message }
}
