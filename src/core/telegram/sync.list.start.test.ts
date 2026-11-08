import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  CHANNEL_ID,
  NOTHING,
  SECOND_ID,
  SUPERGROUP_ID,
  followedOf,
  holdings,
  seedSyncChat,
  storedIdsOf,
  syncListOf,
} from "./sync-list.testing"
import { KEPT, seedKeptMessages, seedListedChats } from "./sync-requests.testing"
import { START_MS, syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeEach(() => {
  fixture = syncFixture()
})

afterEach(() => fixture.close())

const FULL = { chats: 1, messages: 2, edits: 1, topics: 1, deleted: 1, sync_list: 1 }
const keptIds = () => storedIdsOf(fixture, KEPT)

describe("starting with channels off", () => {
  beforeEach(() => {
    seedListedChats(fixture)
    seedKeptMessages(fixture, 1, 2)
    seedSyncChat(fixture, { id: CHANNEL_ID, kind: "channel", listed: true })
    seedSyncChat(fixture, { id: SUPERGROUP_ID, kind: "supergroup", listed: true })
  })

  test("deletes every channel with its messages, earlier versions, topics, tombstones and place on the list", async () => {
    await fixture.running()

    expect(holdings(fixture, CHANNEL_ID)).toEqual(NOTHING)
  })

  test("keeps the other chats as they are, and the listed supergroup followed", async () => {
    await fixture.running()

    expect(holdings(fixture, SUPERGROUP_ID)).toEqual(FULL)
    expect(followedOf(fixture, SUPERGROUP_ID)).toBe(1)
    expect(keptIds()).toEqual([1, 2])
    expect(syncListOf(fixture)).toEqual([{ chat: SUPERGROUP_ID, added: START_MS, seeded: START_MS }])
  })

  test("logs the counts alone", async () => {
    await fixture.running()

    expect(fixture.logs).toContain("sync list: 1 chats kept, 1 channels removed")
    expect(fixture.logs.filter((line) => line.startsWith("sync list"))).toHaveLength(1)
  })

  test("applies the list again at the next start, which finds no channel left", async () => {
    const first = await fixture.running()
    first.stop()
    await first.outcome

    await fixture.running()

    expect(fixture.logs).toContain("sync list: 1 chats kept, 0 channels removed")
  })
})

describe("starting with channels on", () => {
  beforeEach(() => {
    seedSyncChat(fixture, { id: CHANNEL_ID, kind: "channel", listed: true })
    seedSyncChat(fixture, { id: SECOND_ID, kind: "channel", listed: false, followed: true })
  })

  test("keeps a listed channel followed with all it holds, and deletes the messages of one that is not listed", async () => {
    await fixture.running({ channels: true })

    expect(holdings(fixture, CHANNEL_ID)).toEqual(FULL)
    expect(followedOf(fixture, CHANNEL_ID)).toBe(1)
    expect(holdings(fixture, SECOND_ID)).toEqual({ ...FULL, messages: 0, edits: 0, sync_list: 0 })
    expect(followedOf(fixture, SECOND_ID)).toBe(0)
    expect(fixture.logs).toContain("sync list: 1 chats kept, 0 channels removed")
  })
})

describe("starting with supergroups", () => {
  test("a supergroup followed before and no longer listed loses its messages and earlier versions, and stays known", async () => {
    seedSyncChat(fixture, { id: SUPERGROUP_ID, kind: "supergroup", listed: false, followed: true })
    seedSyncChat(fixture, { id: SECOND_ID, kind: "supergroup", listed: true })

    await fixture.running()

    expect(holdings(fixture, SUPERGROUP_ID)).toMatchObject({ chats: 1, messages: 0, edits: 0 })
    expect(followedOf(fixture, SUPERGROUP_ID)).toBe(0)
    expect(holdings(fixture, SECOND_ID)).toEqual(FULL)
    expect(fixture.logs).toContain("sync list: 1 chats kept, 0 channels removed")
  })

  test("a listed supergroup the mirror did not follow is followed", async () => {
    seedSyncChat(fixture, { id: SUPERGROUP_ID, kind: "supergroup", listed: true, followed: false, ids: [] })

    await fixture.running()

    expect(followedOf(fixture, SUPERGROUP_ID)).toBe(1)
  })

  test("an empty mirror starts with an empty list", async () => {
    await fixture.running()

    expect(syncListOf(fixture)).toEqual([])
    expect(fixture.logs).toContain("sync list: 0 chats kept, 0 channels removed")
  })
})
