import { setFollowed } from "./ingest-chats"
import type { Mirror } from "./mirror"
import type { ChatKind } from "./mirror-input"

/** The kinds of chat the sync list can hold: the ones the service keeps only when the user chose them. */
const LISTABLE_KINDS: readonly ChatKind[] = ["supergroup", "channel"]

/** `LISTABLE_KINDS` as a SQL list; built from constants, never from input. */
const LISTABLE_KINDS_SQL = LISTABLE_KINDS.map((kind) => `'${kind}'`).join(", ")

/** Tables that hold rows of a channel under their `chat` column. */
const CHANNEL_TABLES: readonly string[] = ["messages", "edits", "topics", "deleted", "sync_list"]

/** What applying the sync list at the start did, as counts only. */
export type SyncListApplied = { kept: number; channelsRemoved: number }

/** Whether a chat of this kind can be on the sync list. */
export function isListable(kind: ChatKind): boolean {
  return LISTABLE_KINDS.includes(kind)
}

/** Whether a chat is on the sync list. */
export function isListed(mirror: Mirror, chat: string): boolean {
  return mirror.prepare("SELECT 1 FROM sync_list WHERE chat = ?").get(chat) !== undefined
}

/** How many chats the sync list holds. */
export function listSize(mirror: Mirror): number {
  const row = mirror.prepare("SELECT COUNT(*) AS size FROM sync_list").get() as { size: number }
  return row.size
}

/**
 * Puts a chat on the sync list and follows it, to be seeded by the next
 * housekeeping round. Returns false, changing nothing, when it already was on.
 */
export function listChat(mirror: Mirror, chat: string, now: number): boolean {
  const added = mirror
    .prepare("INSERT OR IGNORE INTO sync_list (chat, added, seeded) VALUES (?, ?, NULL)")
    .run(chat, now)
  if (Number(added.changes) === 0) return false
  setFollowed(mirror, chat, true)
  return true
}

/**
 * Takes a chat off the sync list and stops following it, which deletes its
 * mirrored messages and their earlier versions. Returns false, changing
 * nothing, when it was not on the list.
 */
export function unlistChat(mirror: Mirror, chat: string): boolean {
  const removed = mirror.prepare("DELETE FROM sync_list WHERE chat = ?").run(chat)
  if (Number(removed.changes) === 0) return false
  setFollowed(mirror, chat, false)
  return true
}

/** Records that a listed chat's newest messages were fetched; does nothing for a chat no longer on the list. */
export function markSeeded(mirror: Mirror, chat: string, now: number): void {
  mirror.prepare("UPDATE sync_list SET seeded = ? WHERE chat = ?").run(now, chat)
}

/** Deletes every channel the mirror has, with all it holds of it, and returns how many. */
function dropChannels(mirror: Mirror): number {
  for (const table of CHANNEL_TABLES) {
    mirror.prepare(`DELETE FROM ${table} WHERE chat IN (SELECT id FROM chats WHERE kind = 'channel')`).run()
  }
  return Number(mirror.prepare("DELETE FROM chats WHERE kind = 'channel'").run().changes)
}

/**
 * Brings the mirror to what the sync list says: with `channels` off no channel
 * is left, and every supergroup and channel is followed exactly when it is on
 * the list (an unlisted one that was followed loses its messages and their
 * earlier versions). Run it in one transaction, before updates are stored.
 */
export function applySyncList(mirror: Mirror, channels: boolean): SyncListApplied {
  const channelsRemoved = channels ? 0 : dropChannels(mirror)
  const rows = mirror
    .prepare(
      `SELECT chats.id AS id, chats.followed AS followed, sync_list.chat IS NOT NULL AS listed
       FROM chats LEFT JOIN sync_list ON sync_list.chat = chats.id
       WHERE chats.kind IN (${LISTABLE_KINDS_SQL})`,
    )
    .all() as { id: string; followed: number; listed: number }[]
  let kept = 0
  for (const row of rows) {
    if (row.listed) kept++
    if (row.followed !== row.listed) setFollowed(mirror, row.id, Boolean(row.listed))
  }
  return { kept, channelsRemoved }
}
