import { setFollowed, upsertChats } from "./ingest-chats"
import type { Mirror } from "./mirror"
import type { ChatInput, ChatKind } from "./mirror-input"
import { findChat } from "./mirror-rows"

/** The kinds the service follows by itself; supergroups wait for the sync list, channels are only listed. */
const FOLLOWED_KINDS: readonly ChatKind[] = ["user", "bot", "self", "group"]

/** Whether the mirror knows chats of this kind at all: channels only with the `channels` setting on. */
export function keepsKind(kind: ChatKind, channels: boolean): boolean {
  return kind !== "channel" || channels
}

/**
 * Upserts the chats the mirror keeps, and follows those of a followed kind
 * that are not followed yet. A chat the service does not follow is listed
 * only. Returns how many chats were given to the mirror.
 */
export function rememberChats(mirror: Mirror, chats: ChatInput[], now: number, channels: boolean): number {
  const kept = chats.filter((chat) => keepsKind(chat.kind, channels))
  upsertChats(mirror, kept, now)
  for (const chat of kept) {
    if (!FOLLOWED_KINDS.includes(chat.kind)) continue
    const row = findChat(mirror, chat.id)
    if (row && !row.followed) setFollowed(mirror, chat.id, true)
  }
  return kept.length
}
