import { storeMessage } from "./ingest-messages"
import { chatRow, messageInput, rowsOf } from "./mirror.testing"
import type { MarkReadResult } from "./service-requests"
import { askWrite, seedActionChats } from "./sync-action.testing"
import { FORUM, KEPT } from "./sync-requests.testing"
import { CLOSED_TOPIC, OPEN_TOPIC, STORED_IDS } from "./sync-send.testing"
import { START_MS, type SyncFixture } from "./sync.testing"

/** Alice's messages that arrived in `KEPT` after the ones the send tests start from (`STORED_IDS`). */
export const NEWER = [30, 31, 32]

/** The user's own message that arrived in `KEPT` last: it is the newest, and it is never unread. */
export const OWN_NEWEST = 33

/** The forum supergroup's messages of others: one in the General topic, one in each topic the tests seed. */
export const IN_FORUM = { general: 40, open: 41, closed: 42 }

/** The topic ids as the mirror keeps them: none for the General topic. */
const TOPIC_OF: Record<number, number | null> = { 40: null, 41: OPEN_TOPIC, 42: CLOSED_TOPIC }

/**
 * Lists the action tests' chats, and adds Alice's `NEWER` messages and the
 * user's `OWN_NEWEST` to `KEPT`, which then holds `STORED_IDS` and `NEWER`
 * unread, and the others' messages `IN_FORUM` to the forum supergroup, which the
 * mirror keeps.
 */
export function seedMarkReadChats(fixture: SyncFixture): void {
  seedActionChats(fixture)
  fixture.seed((mirror) => {
    const ingest = { now: START_MS, keepDisappearing: false }
    for (const id of NEWER) storeMessage(mirror, ingest, messageInput({ chat: KEPT, id, ts: START_MS - 5_000 }))
    storeMessage(
      mirror,
      ingest,
      messageInput({ chat: KEPT, id: OWN_NEWEST, fromMe: true, sender: null, senderName: null, ts: START_MS - 4_000 }),
    )
    for (const id of Object.values(IN_FORUM)) {
      storeMessage(mirror, ingest, messageInput({ chat: FORUM, id, topic: TOPIC_OF[id], ts: START_MS - 5_000 }))
    }
  })
}

/** Asks the running service to mark read with `params`. */
export function markRead(
  fixture: SyncFixture,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<MarkReadResult> {
  return askWrite<MarkReadResult>(fixture, "mark_read", params, signal)
}

/** The read mark and the unread count the mirror holds of `chat`. */
export function readStateOf(fixture: SyncFixture, chat: string): { read_max: number | null; unread: number } {
  const { read_max, unread } = fixture.mirror((mirror) => chatRow(mirror, chat))!
  return { read_max: read_max as number | null, unread: unread as number }
}

/** The messages the mirror holds of `chat`, so that a test can show a read mark changed none of them. */
export function storedIdsOf(fixture: SyncFixture, chat: string): unknown[] {
  return fixture
    .mirror((mirror) => rowsOf(mirror, "SELECT id FROM messages WHERE chat = ? ORDER BY id", chat))
    .map((row) => row.id)
}

/** The unread count `KEPT` starts at: `STORED_IDS` and `NEWER`, all from Alice. */
export const KEPT_UNREAD = STORED_IDS.length + NEWER.length
