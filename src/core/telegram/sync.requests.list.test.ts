import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { GROUP } from "./mirror.testing"
import { SYNC_LIST_LIMIT, type SyncAddResult, type SyncRemoveResult } from "./service-requests"
import { failureOf } from "./service.testing"
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
import { KEPT, UNLISTED, groupMessage, request, seedListedChats } from "./sync-requests.testing"
import { START_MS, eventually, syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeEach(() => {
  fixture = syncFixture()
  seedListedChats(fixture)
})

afterEach(() => fixture.close())

/** Timings that leave the housekeeping nothing to seed during a test that looks at what the request alone did. */
const QUIET = { roundEveryMs: 1_000_000_000 }

const add = (...chats: string[]) => request<SyncAddResult>(fixture, "sync_add", { chats })
const remove = (...chats: string[]) => request<SyncRemoveResult>(fixture, "sync_remove", { chats })
const refusal = (method: "sync_add" | "sync_remove", ...chats: string[]) =>
  failureOf(request(fixture, method, { chats }))
const idsOf = (chat: string) => storedIdsOf(fixture, chat)

describe("adding to the sync list", () => {
  test("lists the chats, follows them, and records when and that they are not seeded", async () => {
    await fixture.running(QUIET)
    fixture.clock.advance(5_000)

    const result = await add(SUPERGROUP_ID, SECOND_ID)

    expect(result).toEqual({ added: [SUPERGROUP_ID, SECOND_ID], listed: [], size: 2 })
    expect(syncListOf(fixture)).toEqual([
      { chat: SECOND_ID, added: START_MS + 5_000, seeded: null },
      { chat: SUPERGROUP_ID, added: START_MS + 5_000, seeded: null },
    ])
    expect(followedOf(fixture, SUPERGROUP_ID)).toBe(1)
    expect(followedOf(fixture, SECOND_ID)).toBe(1)
  })

  test("makes no call to Telegram itself", async () => {
    await fixture.running(QUIET)
    const before = fixture.client.calls.length

    await add(SUPERGROUP_ID)

    expect(fixture.client.calls).toHaveLength(before)
  })

  test("is idempotent: a chat already listed is reported as listed and left as it was", async () => {
    await fixture.running(QUIET)
    await add(SUPERGROUP_ID)
    fixture.clock.advance(5_000)

    const again = await add(SECOND_ID, SUPERGROUP_ID)

    expect(again).toEqual({ added: [SECOND_ID], listed: [SUPERGROUP_ID], size: 2 })
    expect(syncListOf(fixture)).toEqual([
      { chat: SECOND_ID, added: START_MS + 5_000, seeded: null },
      { chat: SUPERGROUP_ID, added: START_MS, seeded: null },
    ])
    expect(await add(SUPERGROUP_ID, SECOND_ID)).toEqual({ added: [], listed: [SUPERGROUP_ID, SECOND_ID], size: 2 })
  })

  test("lists a channel with channels on", async () => {
    seedSyncChat(fixture, { id: CHANNEL_ID, kind: "channel" })
    await fixture.running({ ...QUIET, channels: true })

    expect(await add(CHANNEL_ID)).toEqual({ added: [CHANNEL_ID], listed: [], size: 1 })
    expect(followedOf(fixture, CHANNEL_ID)).toBe(1)
  })

  test("is seeded by the next housekeeping round", async () => {
    fixture.client.setHistory(SUPERGROUP_ID, groupMessage(2), groupMessage(1))
    await fixture.running()

    await add(SUPERGROUP_ID)

    await eventually(() => idsOf(SUPERGROUP_ID).length === 2 && syncListOf(fixture)[0]?.seeded === START_MS)
    expect(fixture.logs).toContain("seeded 1 chats")
  })

  test("takes up to 30 chats, and refuses a whole call that would pass 30", async () => {
    const ids = Array.from({ length: SYNC_LIST_LIMIT + 1 }, (_, index) => `-100300000${String(index).padStart(4, "0")}`)
    for (const id of ids) seedSyncChat(fixture, { id, kind: "supergroup", ids: [] })
    await fixture.running(QUIET)
    await add(...ids.slice(0, 29))

    const error = await refusal("sync_add", ids[28]!, ids[29]!, ids[30]!)

    expect(error).toMatchObject({
      code: "invalid_argument",
      message: `The sync list holds at most ${SYNC_LIST_LIMIT} chats; remove some first.`,
    })
    expect(syncListOf(fixture)).toHaveLength(29)
    expect(followedOf(fixture, ids[29]!)).toBe(0)
    expect(await add(ids[28]!, ids[29]!)).toMatchObject({
      added: [ids[29]!],
      listed: [ids[28]!],
      size: SYNC_LIST_LIMIT,
    })
  })
})

describe("what adding refuses, changing nothing", () => {
  const unchanged = () => {
    expect(syncListOf(fixture)).toEqual([])
    expect(followedOf(fixture, SUPERGROUP_ID)).toBe(0)
  }

  test("a chat the mirror does not know, even beside good ones", async () => {
    await fixture.running(QUIET)

    expect(await refusal("sync_add", SUPERGROUP_ID, UNLISTED)).toMatchObject({
      code: "not_found",
      message: `The chat list has no chat ${UNLISTED}; refresh it, or check the id.`,
    })
    unchanged()
  })

  test("a private chat or a basic group, which are always mirrored", async () => {
    fixture.seed((mirror) => mirror.exec(`INSERT INTO chats (id, kind, updated) VALUES ('${GROUP}', 'group', 0)`))
    await fixture.running(QUIET)

    for (const chat of [KEPT, GROUP]) {
      expect(await refusal("sync_add", SUPERGROUP_ID, chat)).toMatchObject({
        code: "invalid_argument",
        message: `${chat} is always mirrored: the sync list is for supergroups and channels.`,
      })
    }
    unchanged()
  })

  test("a channel while channels are off", async () => {
    await fixture.running(QUIET)
    fixture.seed((mirror) =>
      mirror.exec(`INSERT INTO chats (id, kind, updated) VALUES ('${CHANNEL_ID}', 'channel', 0)`),
    )

    expect(await refusal("sync_add", SUPERGROUP_ID, CHANNEL_ID)).toMatchObject({
      code: "invalid_argument",
      message: "Channels are off; turn the channels setting on to list them.",
    })
    unchanged()
  })
})

describe("removing from the sync list", () => {
  beforeEach(() => {
    seedSyncChat(fixture, { id: SUPERGROUP_ID, kind: "supergroup", listed: true })
    seedSyncChat(fixture, { id: SECOND_ID, kind: "supergroup", listed: true })
  })

  test("takes the chat off, deletes its messages and earlier versions, and keeps the chat row", async () => {
    await fixture.running(QUIET)

    const result = await remove(SUPERGROUP_ID)

    expect(result).toEqual({ removed: [SUPERGROUP_ID], absent: [], size: 1 })
    expect(holdings(fixture, SUPERGROUP_ID)).toEqual({ ...NOTHING, chats: 1, topics: 1, deleted: 1 })
    expect(followedOf(fixture, SUPERGROUP_ID)).toBe(0)
    expect(holdings(fixture, SECOND_ID)).toMatchObject({ messages: 2, edits: 1, sync_list: 1 })
    expect(followedOf(fixture, SECOND_ID)).toBe(1)
  })

  test("is idempotent: a chat not on the list is reported as absent", async () => {
    await fixture.running(QUIET)

    expect(await remove(SECOND_ID)).toEqual({ removed: [SECOND_ID], absent: [], size: 1 })
    expect(await remove(SECOND_ID, SUPERGROUP_ID)).toEqual({ removed: [SUPERGROUP_ID], absent: [SECOND_ID], size: 0 })
    expect(await remove(SECOND_ID, SUPERGROUP_ID)).toEqual({ removed: [], absent: [SECOND_ID, SUPERGROUP_ID], size: 0 })
  })

  test("refuses a whole call naming a chat the mirror does not know or that is always mirrored", async () => {
    await fixture.running(QUIET)

    expect(await refusal("sync_remove", SUPERGROUP_ID, UNLISTED)).toMatchObject({ code: "not_found" })
    expect(await refusal("sync_remove", SUPERGROUP_ID, KEPT)).toMatchObject({
      code: "invalid_argument",
      message: `${KEPT} is always mirrored: the sync list is for supergroups and channels.`,
    })
    expect(syncListOf(fixture)).toHaveLength(2)
    expect(idsOf(SUPERGROUP_ID)).toEqual([1, 2])
  })

  test("a change in the list is kept for the next start", async () => {
    const first = await fixture.running(QUIET)
    await remove(SUPERGROUP_ID)
    first.stop()
    await first.outcome

    await fixture.running(QUIET)

    expect(syncListOf(fixture).map((row) => row.chat)).toEqual([SECOND_ID])
    expect(fixture.logs).toContain("sync list: 1 chats kept, 0 channels removed")
  })
})

describe("a mirror that cannot be written", () => {
  test("ends the run when the list cannot be changed, as it does elsewhere", async () => {
    const { outcome } = await fixture.running(QUIET)
    fixture.seed((mirror) =>
      mirror.exec("CREATE TRIGGER refuse BEFORE INSERT ON sync_list BEGIN SELECT RAISE(ABORT, 'no'); END"),
    )

    expect(await failureOf(add(SUPERGROUP_ID))).toBeInstanceOf(Error)
    expect(await outcome).toMatchObject({ exitCode: 1, status: "failed" })
    expect(followedOf(fixture, SUPERGROUP_ID)).toBe(0)
  })
})
