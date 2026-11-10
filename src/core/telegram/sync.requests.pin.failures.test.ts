import { tl } from "@mtcute/core"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failureOf } from "./service.testing"
import { answered, type FakeActionScript } from "./sync-client-send.testing"
import { KEPT } from "./sync-requests.testing"
import { THEIRS, actionsOf } from "./sync-action.testing"
import { pin, seedPinChats } from "./sync-pin.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture
let outcome: Awaited<ReturnType<SyncFixture["running"]>>["outcome"]

beforeEach(async () => {
  fixture = syncFixture()
  seedPinChats(fixture)
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

const failure = (unpin?: true) => failureOf(pin(fixture, { chat: KEPT, id: THEIRS, ...(unpin ? { unpin } : {}) }))

const messageIds = () =>
  fixture.mirror((mirror) => mirror.prepare("SELECT id FROM messages WHERE chat = ?").all(KEPT)).length

const REFUSALS: [string, tl.RpcError, string][] = [
  ["a flood wait", answered(420, "FLOOD_WAIT_30"), "rate_limited"],
  ["a chat that does not let this account pin", answered(400, "PIN_RESTRICTED"), "forbidden"],
  ["a chat that needs an admin", answered(403, "CHAT_ADMIN_REQUIRED"), "forbidden"],
  ["a chat that does not take writes", answered(403, "CHAT_WRITE_FORBIDDEN"), "forbidden"],
  ["a one-sided pin with a bot", answered(400, "BOT_ONESIDE_NOT_AVAIL"), "forbidden"],
  ["too many pinned messages", answered(400, "PINNED_TOO_MUCH"), "forbidden"],
  ["a message that is gone", answered(400, "MESSAGE_ID_INVALID"), "not_found"],
  ["a message id Telegram does not know", answered(400, "MSG_ID_INVALID"), "not_found"],
  ["a chat that is gone", answered(400, "PEER_ID_INVALID"), "not_found"],
  ["a refusal of another name", answered(403, "SOMETHING_NEW"), "upstream_error"],
]

describe("a pin Telegram refuses", () => {
  for (const [name, error, code] of REFUSALS) {
    test(`${name} is ${code} with the pin unchanged, and the call is not repeated`, async () => {
      fixture.client.setActionAnswer(error)
      const before = messageIds()

      const refused = await failure()

      expect(refused).toMatchObject({ code })
      expect(refused.message).toMatch(/(the pin is unchanged\.|the pin did not happen\. Try again in \d+ seconds\.)$/)
      expect(actionsOf(fixture)).toHaveLength(1)
      expect(fixture.pauses).toEqual([])
      expect(messageIds()).toBe(before)
    })
  }

  test("says what it was, with Telegram's name for it", async () => {
    fixture.client.setActionAnswer(answered(400, "PINNED_TOO_MUCH"))

    expect((await failure()).message).toBe(
      "Telegram allows no more pinned messages in this chat (PINNED_TOO_MUCH); the pin is unchanged.",
    )
  })

  test("says it in words of an unpin when the call was one", async () => {
    fixture.client.setActionAnswer(answered(403, "CHAT_WRITE_FORBIDDEN"))

    expect((await failure(true)).message).toBe(
      "Telegram does not let this account unpin here (CHAT_WRITE_FORBIDDEN); the pin is unchanged.",
    )
  })
})

describe("a pin whose connection came back during the call", () => {
  for (const [name, error] of REFUSALS) {
    test(`is uncertain even for ${name}`, async () => {
      fixture.client.setActionAnswer(afterReconnect(error))

      const refused = await failure()

      expect(refused).toMatchObject({ code: "uncertain" })
      expect(refused.message).toContain("The pin may have gone through")
      expect(refused.message).toEndWith("Check the message in the chat before pinning it again.")
      expect(actionsOf(fixture)).toHaveLength(1)
    })
  }

  test("is told in words of an unpin when the call was one", async () => {
    fixture.client.setActionAnswer(afterReconnect(answered(403, "CHAT_WRITE_FORBIDDEN")))

    expect((await failure(true)).message).toEndWith("Check the message in the chat before unpinning it again.")
  })
})

describe("a pin that may have gone through", () => {
  const others: [string, Error][] = [
    ["mtcute's own timeout", answered(400, "TIMEOUT")],
    ["a server error", answered(500, "INTERNAL")],
    ["an error that is not Telegram's", new Error("socket to +15550100123 broke")],
  ]
  for (const [name, error] of others) {
    test(`${name} is uncertain, with the advice to check the message`, async () => {
      fixture.client.setActionAnswer(error)

      const refused = await failure()

      expect(refused).toMatchObject({ code: "uncertain" })
      expect(refused.message).not.toContain("15550100123")
      expect(actionsOf(fixture)).toHaveLength(1)
    })
  }

  test("a session that ended is uncertain, and the service ends after the answer", async () => {
    fixture.client.setActionAnswer(answered(401, "SESSION_REVOKED"))

    expect(await failure()).toMatchObject({ code: "uncertain" })
    expect(await outcome).toMatchObject({ status: "logged out" })
  })
})
