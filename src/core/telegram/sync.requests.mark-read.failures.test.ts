import { tl } from "@mtcute/core"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failureOf } from "./service.testing"
import { actionsOf } from "./sync-action.testing"
import { IN_FORUM, KEPT_UNREAD, NEWER, markRead, readStateOf, seedMarkReadChats } from "./sync-mark-read.testing"
import { answered, type FakeActionScript } from "./sync-client-send.testing"
import { FORUM, KEPT } from "./sync-requests.testing"
import { OPEN_TOPIC } from "./sync-send.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture
let outcome: Awaited<ReturnType<SyncFixture["running"]>>["outcome"]

beforeEach(async () => {
  fixture = syncFixture()
  seedMarkReadChats(fixture)
  outcome = (await fixture.running()).outcome
})

afterEach(() => fixture.close())

/** An answer that comes after the connection dropped and came back, as a reconnect during the call shows. */
const afterReconnect =
  (error: Error): FakeActionScript =>
  () => {
    fixture.client.drop()
    fixture.client.regain()
    return error
  }

const failure = (params: Record<string, unknown> = {}) =>
  failureOf(markRead(fixture, { chat: KEPT, up_to: NEWER[0], ...params }))

const REFUSALS: [string, tl.RpcError, string][] = [
  ["a flood wait", answered(420, "FLOOD_WAIT_30"), "rate_limited"],
  ["a chat that needs an admin", answered(403, "CHAT_ADMIN_REQUIRED"), "forbidden"],
  ["a channel that is private now", answered(400, "CHANNEL_PRIVATE"), "not_found"],
  ["a chat that is gone", answered(400, "PEER_ID_INVALID"), "not_found"],
  ["a message that is gone", answered(400, "MESSAGE_ID_INVALID"), "not_found"],
  ["a message id Telegram does not know", answered(400, "MSG_ID_INVALID"), "not_found"],
  ["a topic that is gone", answered(400, "TOPIC_ID_INVALID"), "not_found"],
  ["a refusal of another name", answered(403, "SOMETHING_NEW"), "upstream_error"],
]

describe("a read mark Telegram refuses", () => {
  for (const [name, error, code] of REFUSALS) {
    test(`${name} is ${code} with nothing marked, and the call is not repeated`, async () => {
      fixture.client.setActionAnswer(error)

      const refused = await failure()

      expect(refused).toMatchObject({ code })
      expect(refused.message).toMatch(
        /(nothing was marked read\.|the mark read did not happen\. Try again in \d+ seconds\.)$/,
      )
      expect(actionsOf(fixture)).toHaveLength(1)
      expect(fixture.pauses).toEqual([])
      expect(readStateOf(fixture, KEPT)).toEqual({ read_max: null, unread: KEPT_UNREAD })
    })
  }

  test("says what it was, with Telegram's name for it", async () => {
    fixture.client.setActionAnswer(answered(403, "CHAT_ADMIN_REQUIRED"))

    expect((await failure()).message).toBe(
      "Telegram does not let this account mark read here (CHAT_ADMIN_REQUIRED); nothing was marked read.",
    )
  })

  test("names no 'already' refusal: the calls are idempotent, and a name that says so is no success", async () => {
    fixture.client.setActionAnswer(answered(400, "CHAT_NOT_MODIFIED"))

    expect(await failure()).toMatchObject({ code: "upstream_error" })
  })

  test("is the same for a topic, which has no read mark in the mirror to keep", async () => {
    fixture.client.setActionAnswer(answered(400, "TOPIC_ID_INVALID"))

    expect(await failure({ chat: FORUM, up_to: IN_FORUM.open, topic: OPEN_TOPIC })).toMatchObject({
      code: "not_found",
      message: "Telegram has no such topic (TOPIC_ID_INVALID); nothing was marked read.",
    })
    expect(readStateOf(fixture, FORUM).read_max).toBeNull()
  })
})

describe("a read mark whose connection came back during the call", () => {
  for (const [name, error] of REFUSALS) {
    test(`is uncertain even for ${name}`, async () => {
      fixture.client.setActionAnswer(afterReconnect(error))

      const refused = await failure()

      expect(refused).toMatchObject({ code: "uncertain" })
      expect(refused.message).toContain("The mark read may have gone through")
      expect(refused.message).toEndWith("Check the message in the chat before marking it again.")
      expect(actionsOf(fixture)).toHaveLength(1)
      expect(readStateOf(fixture, KEPT).read_max).toBeNull()
    })
  }
})

describe("a read mark that may have gone through", () => {
  const others: [string, Error][] = [
    ["mtcute's own timeout", answered(400, "TIMEOUT")],
    ["a server error", answered(500, "INTERNAL")],
    ["an error that is not Telegram's", new Error("socket to +15550100123 broke")],
  ]
  for (const [name, error] of others) {
    test(`${name} is uncertain, and the mirror's read mark is not moved`, async () => {
      fixture.client.setActionAnswer(error)

      const refused = await failure()

      expect(refused).toMatchObject({ code: "uncertain" })
      expect(refused.message).not.toContain("15550100123")
      expect(actionsOf(fixture)).toHaveLength(1)
      expect(readStateOf(fixture, KEPT).read_max).toBeNull()
    })
  }

  test("a session that ended is uncertain, and the service ends after the answer", async () => {
    fixture.client.setActionAnswer(answered(401, "SESSION_REVOKED"))

    expect(await failure()).toMatchObject({ code: "uncertain" })
    expect(await outcome).toMatchObject({ status: "logged out" })
  })
})
