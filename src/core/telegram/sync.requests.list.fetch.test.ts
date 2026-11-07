import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { columnOf } from "./mirror.testing"
import type { FetchResult, SyncRemoveResult } from "./service-requests"
import { SUPERGROUP_ID, followedOf, holdings, seedSyncChat, syncListOf } from "./sync-list.testing"
import { groupMessage, request } from "./sync-requests.testing"
import { eventually, syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

/** Telegram has messages 1 to 230 of the supergroup; the mirror holds 201 to 230. */
const NEWEST = 230
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index)

beforeEach(() => {
  fixture = syncFixture()
  seedSyncChat(fixture, { id: SUPERGROUP_ID, kind: "supergroup", listed: true, ids: range(201, NEWEST) })
  fixture.client.setHistory(SUPERGROUP_ID, ...range(1, NEWEST).map((id) => groupMessage(id)))
})

afterEach(() => fixture.close())

const fetch = (pages: number) => request<FetchResult>(fixture, "fetch", { chat: SUPERGROUP_ID, pages })
const storedIds = () =>
  fixture.mirror((mirror) => columnOf(mirror, "SELECT id FROM messages WHERE chat = ? ORDER BY id", SUPERGROUP_ID))
const offsets = () => fixture.client.argsOf("getHistory").map((args) => (args as { offset: { id: number } }).offset.id)

describe("a history fetch of a chat on the sync list", () => {
  test("takes older pages into the mirror like any chat it keeps", async () => {
    await fixture.running()

    expect(await fetch(1)).toMatchObject({ added: 100, pages: 1, complete: false })
    expect(storedIds()).toEqual(range(101, NEWEST))
  })

  test("a chat removed during it stores nothing, asks for no more, and leaves the chat unfollowed", async () => {
    await fixture.running()
    const release = fixture.client.hold("getHistory")
    const asked = fetch(3)
    await eventually(() => offsets().length === 1)

    const removed = await request<SyncRemoveResult>(fixture, "sync_remove", { chats: [SUPERGROUP_ID] })
    release()

    expect(removed).toEqual({ removed: [SUPERGROUP_ID], absent: [], size: 0 })
    expect(await asked).toEqual({ added: 0, pages: 1, oldest_ts: null, complete: false })
    expect(offsets()).toEqual([201])
    expect(storedIds()).toEqual([])
    expect(holdings(fixture, SUPERGROUP_ID)).toMatchObject({ chats: 1, messages: 0, edits: 0, sync_list: 0 })
    expect(followedOf(fixture, SUPERGROUP_ID)).toBe(0)
    expect(syncListOf(fixture)).toEqual([])
  })
})
