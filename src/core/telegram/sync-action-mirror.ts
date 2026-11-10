import { goneMessage, leftChat, noSuchMessage, notOwnMessage } from "./action-checks"
import type { Mirror } from "./mirror"
import { isDeleted, type ChatRow } from "./mirror-rows"
import type { ActionWords } from "./sync-action-outcome"
import { listedChat } from "./sync-request-calls"

/** What an action needs to know of a message the mirror holds. */
export type StoredMessage = {
  kind: "message" | "service"
  /** The text, or the caption of media. */
  body: string | null
  /** The media as JSON; null for a message without. */
  media: string | null
  /** The reactions as JSON; null for a message without. */
  reactions: string | null
  /** When the last edit was made, in milliseconds. */
  edited: number | null
}

/** The chat an action is aimed at, and its message: null when the mirror was told the message is deleted. */
export type ActionTarget = { chat: ChatRow; message: StoredMessage | null }

/** An action's chat and a message the mirror holds. */
export type LiveTarget = { chat: ChatRow; message: StoredMessage }

type StoredRow = StoredMessage & { from_me: number }

/** The columns of message `id` of `chat` that an action looks at, or undefined when the mirror has no such message. */
function storedRow(mirror: Mirror, chat: string, id: number): StoredRow | undefined {
  return mirror
    .prepare("SELECT from_me, kind, body, media, reactions, edited FROM messages WHERE chat = ? AND id = ?")
    .get(chat, id) as StoredRow | undefined
}

/** Message `id` of `chat` as the mirror has it now, or null when it has none. */
export function storedMessageOf(mirror: Mirror, chat: string, id: number): StoredMessage | null {
  const row = storedRow(mirror, chat, id)
  return row ? { kind: row.kind, body: row.body, media: row.media, reactions: row.reactions, edited: row.edited } : null
}

/**
 * The chat and the message an action is aimed at, from the mirror, before
 * anything is asked of Telegram. The chat must be one the mirror lists
 * (`not_found`) and the account must not have left it (`forbidden`). With
 * `whose` `own`, the default, the message must be the user's own
 * (`forbidden`); `anyone` takes any author's. The message must be one the
 * mirror holds: a message it has as deleted gives a null `message`, and any
 * other missing one is `not_found`, since a chat the mirror does not keep
 * holds no messages to check. `words` says what the action is called.
 */
export function targetOf(
  mirror: Mirror,
  chatId: string,
  id: number,
  words: ActionWords,
  whose: "own" | "anyone" = "own",
): ActionTarget {
  const chat = listedChat(mirror, chatId)
  if (chat.left) throw leftChat(words.past)
  const row = storedRow(mirror, chatId, id)
  if (!row) {
    if (isDeleted(mirror, chat, id)) return { chat, message: null }
    throw noSuchMessage(id, chat.followed, words.past)
  }
  if (whose === "own" && row.from_me !== 1) throw notOwnMessage(words.past)
  const { kind, body, media, reactions, edited } = row
  return { chat, message: { kind, body, media, reactions, edited } }
}

/**
 * Like `targetOf` for a message of any author, which must also not be deleted:
 * one the mirror has as deleted is `not_found`, since an action on it cannot
 * succeed.
 */
export function anyMessageOf(mirror: Mirror, chatId: string, id: number, words: ActionWords): LiveTarget {
  const { chat, message } = targetOf(mirror, chatId, id, words, "anyone")
  if (!message) throw goneMessage(words.past)
  return { chat, message }
}
