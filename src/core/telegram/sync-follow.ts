import { setFollowed, upsertChats } from "./ingest-chats"
import type { Mirror } from "./mirror"
import type { ChatInput, ChatKind } from "./mirror-input"
import { findChat } from "./mirror-rows"
import { isListable, isListed } from "./sync-list"

/** The kinds the service follows by itself; supergroups and channels are followed only while on the sync list. */
const FOLLOWED_KINDS: readonly ChatKind[] = ["user", "bot", "self", "group"]

/** Whether the mirror knows chats of this kind at all: channels only with the `channels` setting on. */
export function keepsKind(kind: ChatKind, channels: boolean): boolean {
  return kind !== "channel" || channels
}

/**
 * Upserts the chats the mirror keeps, and follows those that should be: a chat
 * of a followed kind that is not followed yet, and a supergroup or channel
 * exactly when it is on the sync list (one that is not loses its messages and
 * earlier versions). Returns how many chats were given to the mirror.
 */
export function rememberChats(mirror: Mirror, chats: ChatInput[], now: number, channels: boolean): number {
  const kept = chats.filter((chat) => keepsKind(chat.kind, channels))
  upsertChats(mirror, kept, now)
  for (const chat of kept) {
    const listable = isListable(chat.kind)
    if (!listable && !FOLLOWED_KINDS.includes(chat.kind)) continue
    const row = findChat(mirror, chat.id)
    if (!row) continue
    const followed = listable ? isListed(mirror, chat.id) : true
    if (Boolean(row.followed) !== followed) setFollowed(mirror, chat.id, followed)
  }
  return kept.length
}
