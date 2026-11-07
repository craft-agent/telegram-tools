import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { FAKE_DATE, FAKE_IDS, FAKE_MARKED, channelPeer, userPeer } from "./fake-telegram.testing"
import { rpcError } from "./login.testing"
import { SUPERGROUP_ID, seedSyncChat, storedIdsOf, syncListOf, type SeededChat } from "./sync-list.testing"
import { request } from "./sync-requests.testing"
import { START_MS, eventually, fakeDialogFor, fakeHistory, syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeEach(() => {
  fixture = syncFixture()
})

afterEach(() => fixture.close())

const DAY_S = 86_400
const alice = userPeer()
const supergroup = channelPeer()
const OLD = FAKE_DATE - 31 * DAY_S

/** A listed supergroup nothing has been fetched for. */
const UNSEEDED: SeededChat = { id: SUPERGROUP_ID, kind: "supergroup", listed: true, seeded: null, ids: [] }

const histories = () => fixture.client.argsOf("getHistory") as { chat: number; limit: number }[]
const storedIds = (chat: string) => storedIdsOf(fixture, chat)
const seededAt = () => syncListOf(fixture).map((row) => row.seeded)

describe("seeding a chat on the sync list", () => {
  test("gives it its newest 50 messages whatever its last activity, and records when", async () => {
    seedSyncChat(fixture, UNSEEDED)
    fixture.client.setDialogs(fakeDialogFor(supergroup, 3, OLD))
    fixture.client.setHistory(SUPERGROUP_ID, ...fakeHistory(supergroup, 1, 2, 3))

    await fixture.running()
    await eventually(() => seededAt()[0] === START_MS)

    expect(storedIds(SUPERGROUP_ID)).toEqual([1, 2, 3])
    expect(histories()).toEqual([{ chat: Number(SUPERGROUP_ID), limit: 50 }])
  })

  test("a chat with no activity at all is seeded too", async () => {
    seedSyncChat(fixture, UNSEEDED)
    fixture.client.setHistory(SUPERGROUP_ID, ...fakeHistory(supergroup, 1))

    await fixture.running()

    await eventually(() => storedIds(SUPERGROUP_ID).length === 1)
  })

  test("a fetch that returns no message still records the seed, and the chat is not asked again", async () => {
    seedSyncChat(fixture, UNSEEDED)

    await fixture.running()
    await eventually(() => seededAt()[0] === START_MS)
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(histories()).toHaveLength(1)
    expect(storedIds(SUPERGROUP_ID)).toEqual([])
  })

  test("a chat seeded before, even with no messages left and recent activity, is not seeded again", async () => {
    seedSyncChat(fixture, { ...UNSEEDED, seeded: START_MS - 1_000 })
    fixture.client.setDialogs(fakeDialogFor(supergroup, 3))
    fixture.client.setHistory(SUPERGROUP_ID, ...fakeHistory(supergroup, 1, 2, 3))

    await fixture.running()
    await eventually(() => fixture.logs.includes("refreshed 1 chats, filled 0 messages"))
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(histories()).toEqual([])
    expect(seededAt()).toEqual([START_MS - 1_000])
  })

  test("goes ahead of the other chats to seed, which keep the window of 30 days", async () => {
    const quiet = userPeer(FAKE_IDS.bot)
    seedSyncChat(fixture, UNSEEDED)
    fixture.client.setDialogs(fakeDialogFor(alice, 3), fakeDialogFor(supergroup, 4, OLD), fakeDialogFor(quiet, 5, OLD))
    fixture.client.setHistory(FAKE_MARKED.alice, ...fakeHistory(alice, 1, 2, 3))
    fixture.client.setHistory(SUPERGROUP_ID, ...fakeHistory(supergroup, 1, 2, 3, 4))

    await fixture.running({ seedChatsPerRound: 1, roundEveryMs: 1_000_000 })
    await eventually(() => histories().length === 1 && fixture.logs.includes("seeded 1 chats"))

    expect(histories().map((call) => call.chat)).toEqual([Number(SUPERGROUP_ID)])
    expect(storedIds(FAKE_MARKED.bot)).toEqual([])
  })

  test("a failed fetch leaves the chat unseeded, to be tried again up to the attempts", async () => {
    seedSyncChat(fixture, UNSEEDED)
    fixture.client.fail("getHistory", rpcError(400, "CHAT_FORBIDDEN"), 5)

    await fixture.running({ seedAttempts: 2 })
    await eventually(() => histories().length === 2)
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(histories()).toHaveLength(2)
    expect(seededAt()).toEqual([null])
    expect(fixture.logs.filter((line) => line === "seeding failed: CHAT_FORBIDDEN")).toHaveLength(2)
  })
})

describe("a chat removed from the list while it is being seeded", () => {
  test("stores nothing and is not marked", async () => {
    seedSyncChat(fixture, UNSEEDED)
    fixture.client.setHistory(SUPERGROUP_ID, ...fakeHistory(supergroup, 1, 2, 3))
    const release = fixture.client.hold("getHistory")
    await fixture.running()
    await eventually(() => histories().length === 1)

    await request(fixture, "sync_remove", { chats: [SUPERGROUP_ID] })
    release()
    await eventually(() => fixture.logs.includes("seeded 1 chats"))

    expect(storedIds(SUPERGROUP_ID)).toEqual([])
    expect(syncListOf(fixture)).toEqual([])
  })

  test("is seeded again when it is put back on the list within the same run", async () => {
    seedSyncChat(fixture, UNSEEDED)
    fixture.client.setHistory(SUPERGROUP_ID, ...fakeHistory(supergroup, 1, 2, 3))
    await fixture.running()
    await eventually(() => seededAt()[0] === START_MS)

    await request(fixture, "sync_remove", { chats: [SUPERGROUP_ID] })
    await request(fixture, "sync_add", { chats: [SUPERGROUP_ID] })

    await eventually(() => storedIds(SUPERGROUP_ID).length === 3 && histories().length === 2)
    expect(seededAt()).toEqual([START_MS])
  })
})
