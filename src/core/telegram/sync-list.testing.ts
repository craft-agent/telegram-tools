import { FAKE_MARKED } from "./fake-telegram.testing"
import { setFollowed, upsertChats, upsertTopics } from "./ingest-chats"
import { storeMessage } from "./ingest-messages"
import type { ChatKind } from "./mirror-input"
import { recordDeleted } from "./mirror-rows"
import { SUPERGROUP, chatInput, columnOf, messageInput, rowsOf } from "./mirror.testing"
import { START_MS, type SyncFixture } from "./sync.testing"

/** The supergroup the fake Telegram has, as the mirror knows it. */
export const SUPERGROUP_ID = FAKE_MARKED.supergroup

/** The channel the fake Telegram has, as the mirror knows it. */
export const CHANNEL_ID = FAKE_MARKED.channel

/** A second supergroup, one the fake Telegram has no peer for. */
export const SECOND_ID = SUPERGROUP

/** The tables that hold rows under a chat, besides the chat itself. */
const HELD_IN = ["messages", "edits", "topics", "deleted", "sync_list"] as const

/** A supergroup or channel as an earlier run left it. */
export type SeededChat = {
  id: string
  kind: ChatKind
  /** Whether the chat is on the sync list; false by default. */
  listed?: boolean
  /** When it was seeded (`null`: not yet); the start of the run by default. */
  seeded?: number | null
  /** Whether the mirror followed it; as `listed` by default. */
  followed?: boolean
  /** The ids of the messages it holds; the first of them has an earlier version. */
  ids?: number[]
}

/** Writes a chat into the label's mirror with the messages, an earlier version, a topic and a tombstone it holds. */
export function seedSyncChat(fixture: SyncFixture, chat: SeededChat): void {
  const { id, kind, listed = false, seeded = START_MS, followed = listed, ids = [1, 2] } = chat
  fixture.seed((mirror) => {
    upsertChats(mirror, [chatInput({ id, kind, name: "Made-up chat", username: null })], START_MS)
    if (followed) setFollowed(mirror, id, true)
    const ctx = { now: START_MS, keepDisappearing: false }
    for (const message of ids) storeMessage(mirror, ctx, messageInput({ chat: id, id: message, ts: START_MS - 60_000 }))
    const [first] = ids
    if (first !== undefined) {
      const edited = messageInput({
        chat: id,
        id: first,
        ts: START_MS - 60_000,
        body: "edited",
        edited: START_MS - 1_000,
      })
      storeMessage(mirror, ctx, edited)
    }
    upsertTopics(mirror, [{ chat: id, id: 5, title: "Made-up topic" }], START_MS)
    recordDeleted(mirror, id, 99, START_MS)
    if (listed) mirror.prepare("INSERT INTO sync_list (chat, added, seeded) VALUES (?, ?, ?)").run(id, START_MS, seeded)
  })
}

/** How many rows of each table a chat has, and how many chats rows it has (`chats`). */
export function holdings(fixture: SyncFixture, id: string): Record<string, number> {
  return fixture.mirror((mirror) => {
    const count = (table: string, column: string) =>
      Number(rowsOf(mirror, `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, id)[0]?.n)
    return Object.fromEntries([
      ["chats", count("chats", "id")],
      ...HELD_IN.map((table) => [table, count(table, "chat")]),
    ])
  })
}

/** What a chat holds when it holds nothing at all. */
export const NOTHING = { chats: 0, messages: 0, edits: 0, topics: 0, deleted: 0, sync_list: 0 }

/** A row of the sync list. */
export type SyncListRow = { chat: string; added: number; seeded: number | null }

/** The sync list as the mirror holds it. */
export function syncListOf(fixture: SyncFixture): SyncListRow[] {
  return fixture.mirror(
    (mirror) => rowsOf(mirror, "SELECT chat, added, seeded FROM sync_list ORDER BY chat") as SyncListRow[],
  )
}

/** The ids of messages a chat holds in the mirror, in id order. */
export function storedIdsOf(fixture: SyncFixture, id: string): number[] {
  return fixture.mirror((mirror) =>
    columnOf(mirror, "SELECT id FROM messages WHERE chat = ? ORDER BY id", id),
  ) as number[]
}

/** Whether the mirror follows a chat (1 or 0); undefined when it has no such chat. */
export function followedOf(fixture: SyncFixture, id: string): number | undefined {
  const row = fixture.mirror((mirror) => rowsOf(mirror, "SELECT followed FROM chats WHERE id = ?", id)[0])
  return row?.followed as number | undefined
}
