import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { recordDeleted } from "./mirror-rows"
import { setFollowed } from "./ingest-chats"
import { floodWait, rpcError } from "./login.testing"
import { columnOf, rowsOf } from "./mirror.testing"
import type { FetchResult } from "./service-requests"
import { failureOf } from "./service.testing"
import { KEPT, keptMessage, request, seedKeptMessages, seedListedChats, sentAtMs } from "./sync-requests.testing"
import { START_MS, eventually, syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

/** Telegram has messages 1 to 230 of the kept chat; the mirror, once `begin` ran, has 201 to 230. */
const NEWEST = 230

beforeEach(() => {
  fixture = syncFixture()
  seedListedChats(fixture)
  fixture.client.setHistory(KEPT, ...range(1, NEWEST).map((id) => keptMessage(id)))
})

afterEach(() => fixture.close())

const chat = Number(KEPT)
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index)
const fetch = (pages: number) => request<FetchResult>(fixture, "fetch", { chat: KEPT, pages })
const storedIds = () =>
  fixture.mirror((mirror) => columnOf(mirror, "SELECT id FROM messages WHERE chat = ? ORDER BY id", KEPT))
const offsets = () => fixture.client.argsOf("getHistory").map((args) => (args as { offset: { id: number } }).offset.id)

/** Stores messages 201 to 230 as an earlier run left them, then starts the service. */
function begin(overrides: Parameters<SyncFixture["running"]>[0] = {}) {
  seedKeptMessages(fixture, 201, NEWEST)
  return fixture.running(overrides)
}

describe("a history fetch", () => {
  test("takes pages from below the oldest stored message, and stores them", async () => {
    await begin()

    const result = await fetch(2)

    expect(fixture.client.argsOf("getHistory")).toEqual([
      { chat, limit: 100, offset: { id: 201, date: 0 } },
      { chat, limit: 100, offset: { id: 101, date: 0 } },
    ])
    expect(result).toEqual({ added: 200, pages: 2, oldest_ts: sentAtMs(1), complete: false })
    expect(storedIds()).toEqual(range(1, NEWEST))
  })

  test("continues from what the earlier fetch stored", async () => {
    await begin()

    await fetch(1)
    const result = await fetch(1)

    expect(offsets()).toEqual([201, 101])
    expect(result).toEqual({ added: 100, pages: 1, oldest_ts: sentAtMs(1), complete: false })
  })

  test("pauses as the service paces its fetches between pages, and not before the first", async () => {
    await begin()

    await fetch(1)
    expect(fixture.pauses).toEqual([])

    await fetch(2)
    expect(fixture.pauses).toHaveLength(1)
    expect(fixture.pauses[0]).toBeGreaterThanOrEqual(500)
    expect(fixture.pauses[0]).toBeLessThanOrEqual(1500)
  })

  test("is complete once Telegram has nothing older, and asks no further", async () => {
    await begin()

    const result = await fetch(5)

    expect(result).toEqual({ added: 200, pages: 3, oldest_ts: sentAtMs(1), complete: true })
    expect(offsets()).toEqual([201, 101, 1])
    expect(fixture.pauses).toHaveLength(2)
  })

  test("is complete on a page shorter than a full one", async () => {
    fixture.client.setHistory(KEPT, ...range(141, NEWEST).map((id) => keptMessage(id)))
    await begin()

    expect(await fetch(5)).toEqual({ added: 60, pages: 1, oldest_ts: sentAtMs(141), complete: true })
    expect(fixture.pauses).toEqual([])
  })

  test("starts from the newest messages in a chat the mirror has none of", async () => {
    fixture.client.setHistory(KEPT, ...range(1, 40).map((id) => keptMessage(id)))
    await fixture.running()

    const result = await fetch(3)

    expect(offsets()).toEqual([0])
    expect(result).toEqual({ added: 40, pages: 1, oldest_ts: sentAtMs(1), complete: true })
  })

  test("stores nothing and says so when Telegram has no messages", async () => {
    fixture.client.setHistory(KEPT)
    await fixture.running()

    expect(await fetch(2)).toEqual({ added: 0, pages: 1, oldest_ts: null, complete: true })
  })
})

describe("what a fetch stores", () => {
  test("does not count a message the mirror got while the page was on its way", async () => {
    await begin()
    const release = fixture.client.hold("getHistory")
    const asked = fetch(1)
    await eventually(() => offsets().length === 1)

    fixture.client.onNewMessage.emit(keptMessage(150))
    await eventually(() => storedIds().includes(150))
    release()

    expect(await asked).toMatchObject({ added: 99, pages: 1 })
    expect(storedIds()).toEqual(range(101, NEWEST))
  })

  test("drops a message deleted for everyone, and does not count it", async () => {
    fixture.seed((mirror) => recordDeleted(mirror, KEPT, 150, START_MS))
    await begin()

    expect(await fetch(1)).toMatchObject({ added: 99 })
    expect(storedIds()).not.toContain(150)
  })

  test("leaves the chat's unread count as the dialog list gave it", async () => {
    seedKeptMessages(fixture, 201, NEWEST)
    fixture.seed((mirror) => void mirror.prepare("UPDATE chats SET unread = 3 WHERE id = ?").run(KEPT))
    await fixture.running()

    await fetch(2)

    const unread = () => fixture.mirror((mirror) => rowsOf(mirror, "SELECT unread FROM chats WHERE id = ?", KEPT))
    expect(unread()).toEqual([{ unread: 3 }])
    expect(storedIds()).toHaveLength(NEWEST)
  })
})

describe("a chat that stops being kept during a fetch", () => {
  const unfollow = () => fixture.seed((mirror) => setFollowed(mirror, KEPT, false))

  test("stores nothing of the page that was on its way, and asks for no more", async () => {
    await begin()
    const release = fixture.client.hold("getHistory")
    const asked = fetch(3)
    await eventually(() => offsets().length === 1)

    unfollow()
    release()

    expect(await asked).toEqual({ added: 0, pages: 1, oldest_ts: null, complete: false })
    expect(offsets()).toEqual([201])
    expect(storedIds()).toEqual([])
  })

  test("asks for no more pages once it is not kept at the pause between them", async () => {
    await begin({ pause: async () => unfollow() })

    expect(await fetch(3)).toEqual({ added: 100, pages: 1, oldest_ts: null, complete: false })
    expect(offsets()).toEqual([201])
    expect(storedIds()).toEqual([])
  })
})

describe("when Telegram refuses a later page", () => {
  const failAtPause = (error: Error) => ({ pause: async () => fixture.client.fail("getHistory", error) })

  test("returns what the first pages stored, not complete, and does not retry a flood wait", async () => {
    await begin(failAtPause(floodWait(42)))

    expect(await fetch(3)).toEqual({ added: 100, pages: 1, oldest_ts: sentAtMs(101), complete: false })
    expect(offsets()).toEqual([201, 101])
    expect(fixture.logs).toContain(
      "history fetch stopped after 1 pages: Telegram is limiting requests from this account; try again in 42 seconds.",
    )
  })

  test("logs the error by Telegram's name only", async () => {
    const error = rpcError(400, "CHAT_ADMIN_REQUIRED")
    error.message = "CHAT_ADMIN_REQUIRED: a private note from the chat"
    await begin(failAtPause(error))

    expect(await fetch(2)).toMatchObject({ added: 100, pages: 1, complete: false })
    expect(fixture.logs).toContain(
      "history fetch stopped after 1 pages: Telegram refused the request (CHAT_ADMIN_REQUIRED).",
    )
    expect(fixture.logs.some((line) => line.includes("private note"))).toBe(false)
  })

  test("still ends the run, and fails the request, when the session ended", async () => {
    const { outcome } = await begin(failAtPause(rpcError(401, "AUTH_KEY_UNREGISTERED")))

    expect(await failureOf(fetch(2))).toMatchObject({ code: "upstream_error" })
    expect(await outcome).toMatchObject({ exitCode: 0, status: "logged out" })
    expect(storedIds()).toEqual(range(101, NEWEST))
  })
})

describe("fetches are taken one at a time", () => {
  test("a second request waits for the first and starts from what the first stored", async () => {
    await begin()
    const release = fixture.client.hold("getHistory")
    const first = fetch(1)
    await eventually(() => offsets().length === 1)

    const second = fetch(1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(offsets()).toEqual([201])

    release()

    expect(await first).toMatchObject({ added: 100 })
    expect(await second).toMatchObject({ added: 100 })
    expect(offsets()).toEqual([201, 101])
  })
})

describe("a mirror that cannot be written", () => {
  test("ends the run, as it does elsewhere, and the request gets no answer", async () => {
    const { outcome } = await begin()
    fixture.seed((mirror) =>
      mirror.exec("CREATE TRIGGER refuse BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'no'); END"),
    )

    expect(await failureOf(fetch(1))).toBeInstanceOf(Error)
    expect(await outcome).toMatchObject({ exitCode: 1, status: "failed" })
  })
})
