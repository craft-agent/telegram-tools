import { Long, tl } from "@mtcute/core"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rpcError } from "./login.testing"
import { rowsOf } from "./mirror.testing"
import { failureOf } from "./service.testing"
import { FORUM, KEPT } from "./sync-requests.testing"
import { TEXT, privateUpdates, seedSendChats, send, sendsOf } from "./sync-send.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"
import { answered, type FakeCallScript } from "./sync-client-send.testing"

let fixture: SyncFixture
let outcome: Awaited<ReturnType<SyncFixture["running"]>>["outcome"]

beforeEach(async () => {
  fixture = syncFixture()
  seedSendChats(fixture)
  outcome = (await fixture.running()).outcome
})

afterEach(() => fixture.close())

/** An answer that comes after the connection dropped and came back, as a reconnect during the call shows. */
const afterReconnect =
  (error: Error): FakeCallScript =>
  () => {
    fixture.client.drop()
    fixture.client.regain()
    return error
  }

const failure = () => failureOf(send(fixture, { chat: KEPT, text: TEXT }))

const storedCount = () =>
  fixture.mirror((mirror) => rowsOf(mirror, "SELECT COUNT(*) AS n FROM messages WHERE chat = ?", KEPT)[0]?.n)

const REFUSALS: [string, tl.RpcError, string][] = [
  ["a flood wait", answered(420, "FLOOD_WAIT_30"), "rate_limited"],
  ["a slow-mode wait", answered(420, "SLOWMODE_WAIT_17"), "rate_limited"],
  ["a premium flood wait", answered(420, "FLOOD_PREMIUM_WAIT_5"), "rate_limited"],
  ["a chat that does not take writes", answered(403, "CHAT_WRITE_FORBIDDEN"), "forbidden"],
  ["a closed topic", answered(403, "TOPIC_CLOSED"), "forbidden"],
  ["a blocked user", answered(400, "USER_IS_BLOCKED"), "forbidden"],
  ["a chat that is gone", answered(400, "PEER_ID_INVALID"), "not_found"],
  ["a reply to a message that is gone", answered(400, "REPLY_MESSAGE_ID_INVALID"), "not_found"],
  ["a text that is too long", answered(400, "MESSAGE_TOO_LONG"), "invalid_argument"],
  ["an empty text", answered(400, "MESSAGE_EMPTY"), "invalid_argument"],
  ["a refusal of another name", answered(403, "SOMETHING_NEW"), "upstream_error"],
  ["a refusal of another name as not acceptable", answered(406, "SOMETHING_ELSE"), "upstream_error"],
]

describe("a send Telegram refuses", () => {
  for (const [name, error, code] of REFUSALS) {
    test(`${name} is ${code} with nothing sent, and the call is not repeated`, async () => {
      fixture.client.setCallAnswer(error)

      const refused = await failure()

      expect(refused).toMatchObject({ code })
      expect(refused.message).toMatch(/nothing was sent\.( Try again in \d+ seconds\.)?$/)
      expect(sendsOf(fixture)).toHaveLength(1)
      expect(fixture.pauses).toEqual([])
      expect(storedCount()).toBe(3)
    })
  }

  test("a flood wait says how long to wait", async () => {
    fixture.client.setCallAnswer(answered(420, "FLOOD_WAIT_30"))

    expect((await failure()).message).toBe(
      "Telegram is limiting sends from this account; nothing was sent. Try again in 30 seconds.",
    )
  })

  test("a connection state of connected alone is no reconnect, so the refusal stands", async () => {
    fixture.client.setCallAnswer(() => {
      fixture.client.onConnectionState.emit("connected")
      return answered(403, "CHAT_WRITE_FORBIDDEN")
    })

    expect(await failure()).toMatchObject({ code: "forbidden" })
  })
})

describe("a send whose connection came back during the call", () => {
  for (const [name, error] of REFUSALS) {
    test(`is uncertain even for ${name}`, async () => {
      fixture.client.setCallAnswer(afterReconnect(error))

      const refused = await failure()

      expect(refused).toMatchObject({ code: "uncertain" })
      expect(refused.message).toContain("The message may have been sent")
      expect(sendsOf(fixture)).toHaveLength(1)
    })
  }

  test("is uncertain when updating was the state seen", async () => {
    fixture.client.setCallAnswer(() => {
      fixture.client.onConnectionState.emit("updating")
      return answered(403, "CHAT_WRITE_FORBIDDEN")
    })

    expect(await failure()).toMatchObject({ code: "uncertain" })
  })

  test("is judged by the states of its own call only: the next send's refusal stands again", async () => {
    fixture.client.setCallAnswer(afterReconnect(answered(403, "CHAT_WRITE_FORBIDDEN")))
    await failure()
    const listening = fixture.client.onConnectionState.length

    fixture.client.setCallAnswer(answered(403, "CHAT_WRITE_FORBIDDEN"))

    expect(await failure()).toMatchObject({ code: "forbidden" })
    expect(fixture.client.onConnectionState.length).toBe(listening)
  })
})

describe("a send that may have gone out", () => {
  const others: [string, Error][] = [
    ["mtcute's own timeout", answered(400, "TIMEOUT")],
    ["a server error", answered(500, "INTERNAL")],
    ["a service that is unavailable", answered(-503, "Timeout")],
    ["an authorization error", answered(401, "AUTH_KEY_PERM_EMPTY")],
    ["a redirect", answered(303, "PHONE_MIGRATE_%d")],
    ["an error that is not Telegram's", new Error("socket to +15550100123 broke")],
  ]
  for (const [name, error] of others) {
    test(`${name} is uncertain, with the advice to check the chat`, async () => {
      fixture.client.setCallAnswer(error)

      const refused = await failure()

      expect(refused).toMatchObject({ code: "uncertain" })
      expect(refused.message).toEndWith("Check the chat in Telegram before trying again.")
      expect(sendsOf(fixture)).toHaveLength(1)
      expect(refused.message).not.toContain("15550100123")
    })
  }

  test("a session that ended is uncertain and ends the service", async () => {
    fixture.client.setCallAnswer(answered(401, "SESSION_REVOKED"))

    expect(await failure()).toMatchObject({ code: "uncertain" })
    expect(await outcome).toMatchObject({ status: "logged out" })
  })

  test("a response without the message is uncertain, and stores nothing", async () => {
    const another = Long.fromString("42")
    fixture.client.setCallAnswer((call) => {
      const response = privateUpdates(call, 51)
      const updates = response.updates.map((update) =>
        update._ === "updateMessageID" ? { ...update, randomId: another } : update,
      )
      return { ...response, updates }
    })

    expect(await failure()).toMatchObject({ code: "uncertain" })
    expect(storedCount()).toBe(3)
  })

  test("a response of another kind is uncertain", async () => {
    fixture.client.setCallAnswer({ _: "updatesTooLong" })

    expect(await failure()).toMatchObject({ code: "uncertain" })
  })

  test("never puts the text, the chat or the random id in the log", async () => {
    fixture.client.setCallAnswer(rpcError(400, "TIMEOUT"))
    await failure()
    const randomId = sendsOf(fixture)[0]!.request.randomId.toString()

    const log = fixture.logs.join("\n")
    expect(log).toContain("send failed: TIMEOUT")
    for (const secret of [TEXT, KEPT, FORUM, randomId]) expect(log).not.toContain(secret)
  })
})
