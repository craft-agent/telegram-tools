import { MtPeerNotFoundError } from "@mtcute/core"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { floodWait, rpcError } from "./login.testing"
import { failureOf } from "./service.testing"
import { REFRESH_REUSE_MS } from "./sync-chat-refresh"
import { FORUM, KEPT, forumTopic, request, seedListedChats } from "./sync-requests.testing"
import { eventually, syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeEach(() => {
  fixture = syncFixture()
  seedListedChats(fixture)
})

afterEach(() => fixture.close())

/** The requests that call Telegram, by the client method each makes. */
const CALLS = [
  {
    name: "a read around a message",
    method: "getHistory",
    send: () => request(fixture, "around", { chat: FORUM, id: 5, before_count: 1, after_count: 1 }),
  },
  {
    name: "a topic read around a message",
    method: "searchMessages",
    send: () => request(fixture, "around", { chat: FORUM, id: 5, before_count: 1, after_count: 1, topic: 3 }),
  },
  { name: "a history fetch", method: "getHistory", send: () => request(fixture, "fetch", { chat: KEPT, pages: 2 }) },
  { name: "a live read", method: "getHistory", send: () => request(fixture, "history", { chat: FORUM, limit: 5 }) },
  {
    name: "a topic read",
    method: "searchMessages",
    send: () => request(fixture, "history", { chat: FORUM, limit: 5, topic: 3 }),
  },
  {
    name: "the topic list",
    method: "getForumTopics",
    send: () => request(fixture, "topics", { chat: FORUM, limit: 5 }),
  },
] as const

describe("when Telegram refuses a request", () => {
  for (const { name, method, send } of CALLS) {
    test(`a flood wait on ${name} says how long to wait and is not retried`, async () => {
      await fixture.running()
      fixture.client.fail(method, floodWait(42))

      expect(await failureOf(send())).toMatchObject({
        code: "upstream_error",
        message: "Telegram is limiting requests from this account; try again in 42 seconds.",
      })
      expect(fixture.client.argsOf(method)).toHaveLength(1)
      expect(fixture.pauses).not.toContain(42_000)
    })

    test(`another error on ${name} is told by Telegram's name for it only`, async () => {
      await fixture.running()
      const error = rpcError(400, "CHAT_ADMIN_REQUIRED")
      error.message = "CHAT_ADMIN_REQUIRED: a private note from the chat"
      fixture.client.fail(method, error)

      const failure = await failureOf(send())

      expect(failure).toMatchObject({
        code: "upstream_error",
        message: "Telegram refused the request (CHAT_ADMIN_REQUIRED).",
      })
      expect(fixture.logs.some((line) => line.includes("private note"))).toBe(false)
    })

    test(`an error that is not Telegram's on ${name} is told without its message`, async () => {
      await fixture.running()
      fixture.client.fail(method, new Error("socket to +15550100123 broke, session abc123"))

      const failure = await failureOf(send())

      expect(failure).toMatchObject({
        code: "upstream_error",
        message: "Telegram did not answer the request; try again.",
      })
      expect(fixture.logs.join("\n")).not.toMatch(/15550100123|abc123/)
    })

    test(`a chat Telegram no longer gives is not found on ${name}`, async () => {
      await fixture.running()
      const gone = ["CHANNEL_PRIVATE", "CHANNEL_INVALID", "PEER_ID_INVALID"].map((text) => rpcError(400, text))
      for (const error of [...gone, new MtPeerNotFoundError("peer not cached")]) {
        fixture.client.fail(method, error)

        expect(await failureOf(send())).toMatchObject({ code: "not_found" })
      }
    })

    test(`a session that ended on ${name} ends the run, and the request is told so`, async () => {
      const { outcome } = await fixture.running()
      fixture.client.fail(method, rpcError(401, "AUTH_KEY_UNREGISTERED"))

      const failure = await failureOf(send())

      expect(failure).toMatchObject({ code: "upstream_error" })
      expect(await outcome).toMatchObject({ exitCode: 0, status: "logged out" })
    })
  }

  test("a session that ended during a refresh ends the run too", async () => {
    const { outcome } = await fixture.running()
    await eventually(() => fixture.meta().refreshed_at !== undefined)
    fixture.clock.advance(REFRESH_REUSE_MS)
    fixture.client.fail("iterDialogs", rpcError(401, "SESSION_REVOKED"))

    expect(await failureOf(request(fixture, "refresh"))).toMatchObject({ code: "upstream_error" })
    expect(await outcome).toMatchObject({ status: "logged out" })
  })

  test("a flood wait during a refresh is told as it is", async () => {
    await fixture.running()
    await eventually(() => fixture.meta().refreshed_at !== undefined)
    fixture.clock.advance(REFRESH_REUSE_MS)
    fixture.client.fail("iterDialogs", floodWait(9))

    expect(await failureOf(request(fixture, "refresh"))).toMatchObject({
      code: "upstream_error",
      message: "Telegram is limiting requests from this account; try again in 9 seconds.",
    })
  })
})

describe("when the service stops", () => {
  test("a request still waiting for Telegram does not hold up the stop", async () => {
    fixture.client.setTopics(FORUM, forumTopic(5))
    const { stop, outcome } = await fixture.running()
    fixture.client.hold("getForumTopics")

    const asked = failureOf(request(fixture, "topics", { chat: FORUM, limit: 5 }))
    await eventually(() => fixture.client.argsOf("getForumTopics").length === 1)
    stop()

    expect(await outcome).toEqual({ exitCode: 0, status: "stopped" })
    expect(await asked).toBeInstanceOf(Error)
  })
})
