import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { FAKE_MARKED, userPeer } from "./fake-telegram.testing"
import { storeMessage } from "./ingest-messages"
import { rpcError } from "./login.testing"
import { messageInput } from "./mirror.testing"
import type { RefreshResult } from "./service-requests"
import { failureOf } from "./service.testing"
import { REFRESH_REUSE_MS } from "./sync-chat-refresh"
import { request, seedListedChats } from "./sync-requests.testing"
import { START_MS, eventually, fakeDialogFor, syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeEach(() => {
  fixture = syncFixture()
  seedListedChats(fixture)
})

afterEach(() => fixture.close())

const refresh = () => request<RefreshResult>(fixture, "refresh")
const dialogReads = () => fixture.client.argsOf("iterDialogs").length
const firstRefreshDone = () => eventually(() => fixture.meta().refreshed_at === String(START_MS))

/** Starts the service and waits for the refresh it makes on its own at the start. */
async function runAfterFirstRefresh(overrides = {}) {
  const started = await fixture.running(overrides)
  await firstRefreshDone()
  return started
}

describe("the chat list refresh a request asks for", () => {
  test("reads the chat list once more and answers with the time it was stored", async () => {
    await runAfterFirstRefresh()
    fixture.clock.advance(REFRESH_REUSE_MS + 1_000)

    const result = await refresh()

    expect(result).toEqual({ refreshed_at: START_MS + REFRESH_REUSE_MS + 1_000 })
    expect(fixture.meta().refreshed_at).toBe(String(result.refreshed_at))
    expect(fixture.client.argsOf("iterDialogs")).toEqual([{ archived: "keep" }, { archived: "keep" }])
  })

  test("answers with the time of a refresh that finished within the minute, without reading the list again", async () => {
    await runAfterFirstRefresh()
    fixture.clock.advance(REFRESH_REUSE_MS - 1)

    expect(await refresh()).toEqual({ refreshed_at: START_MS })
    expect(await refresh()).toEqual({ refreshed_at: START_MS })
    expect(dialogReads()).toBe(1)
  })

  test("reads the list again once the minute has passed since the last refresh", async () => {
    await runAfterFirstRefresh()
    fixture.clock.advance(REFRESH_REUSE_MS)

    expect((await refresh()).refreshed_at).toBe(START_MS + REFRESH_REUSE_MS)
    fixture.clock.advance(REFRESH_REUSE_MS - 1)
    expect((await refresh()).refreshed_at).toBe(START_MS + REFRESH_REUSE_MS)
    expect(dialogReads()).toBe(2)
  })

  test("that fails answers with Telegram's name for the error, and leaves the stored time alone", async () => {
    await runAfterFirstRefresh()
    fixture.clock.advance(REFRESH_REUSE_MS)
    fixture.client.fail("iterDialogs", rpcError(500, "RPC_CALL_FAIL"))

    expect(await failureOf(refresh())).toMatchObject({
      code: "upstream_error",
      message: "Telegram refused the request (RPC_CALL_FAIL).",
    })
    expect(fixture.meta().refreshed_at).toBe(String(START_MS))
  })
})

describe("a refresh during the service's own round", () => {
  test("waits for the round and answers with its time, without a second read of the list", async () => {
    const release = fixture.client.hold("iterDialogs")
    await fixture.running()
    await eventually(() => dialogReads() === 1)

    let answer: RefreshResult | undefined
    const asked = refresh().then((result) => (answer = result))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(answer).toBeUndefined()
    release()
    await asked

    expect(answer).toEqual({ refreshed_at: START_MS })
    expect(dialogReads()).toBe(1)
  })

  test("is answered once the list is stored, not after the gaps in the chats are filled", async () => {
    fixture.seed((mirror) =>
      storeMessage(
        mirror,
        { now: START_MS, keepDisappearing: false },
        messageInput({ id: 5, chat: FAKE_MARKED.alice }),
      ),
    )
    fixture.client.setDialogs(fakeDialogFor(userPeer(), 9))
    const release = fixture.client.hold("getHistory")
    await fixture.running()
    await eventually(() => fixture.client.argsOf("getHistory").length === 1)
    fixture.clock.advance(REFRESH_REUSE_MS * 2)

    expect(await refresh()).toEqual({ refreshed_at: START_MS })
    release()
  })

  test("is never made at the same time as the service's own refresh", async () => {
    await runAfterFirstRefresh({ refreshEveryMs: 1_000 })
    const release = fixture.client.hold("iterDialogs")
    fixture.clock.advance(REFRESH_REUSE_MS)

    const asked = refresh()
    await eventually(() => dialogReads() === 2)
    await new Promise((resolve) => setTimeout(resolve, 150))
    release()

    expect(await asked).toEqual({ refreshed_at: START_MS + REFRESH_REUSE_MS })
    expect(dialogReads()).toBe(2)
  })
})
