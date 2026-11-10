import { tl } from "@mtcute/core"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rpcError } from "./login.testing"
import { messageRow } from "./mirror.testing"
import { failureOf } from "./service.testing"
import { answered, type FakeActionScript } from "./sync-client-send.testing"
import { FORUM, KEPT } from "./sync-requests.testing"
import { NEW_TEXT, OWN, OWN_TEXT, actionsOf, edit, editedInPrivate, seedActionChats } from "./sync-action.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture
let outcome: Awaited<ReturnType<SyncFixture["running"]>>["outcome"]

beforeEach(async () => {
  fixture = syncFixture()
  seedActionChats(fixture)
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

const failure = () => failureOf(edit(fixture, { chat: KEPT, id: OWN.text, text: NEW_TEXT }))

const unchanged = () =>
  expect(fixture.mirror((mirror) => messageRow(mirror, KEPT, OWN.text))).toMatchObject({ body: OWN_TEXT })

const REFUSALS: [string, tl.RpcError, string][] = [
  ["a flood wait", answered(420, "FLOOD_WAIT_30"), "rate_limited"],
  ["a slow-mode wait", answered(420, "SLOWMODE_WAIT_17"), "rate_limited"],
  ["a message past its edit time", answered(400, "MESSAGE_EDIT_TIME_EXPIRED"), "forbidden"],
  ["a message of another author", answered(403, "MESSAGE_AUTHOR_REQUIRED"), "forbidden"],
  ["a temporary restriction", answered(400, "EDIT_MESSAGE_TEMP_RESTRICTED"), "forbidden"],
  ["a chat that does not take writes", answered(403, "CHAT_WRITE_FORBIDDEN"), "forbidden"],
  ["a message that is gone", answered(400, "MESSAGE_ID_INVALID"), "not_found"],
  ["a message id Telegram does not know", answered(400, "MSG_ID_INVALID"), "not_found"],
  ["a chat that is gone", answered(400, "PEER_ID_INVALID"), "not_found"],
  ["a text that is too long", answered(400, "MESSAGE_TOO_LONG"), "invalid_argument"],
  ["an empty text", answered(400, "MESSAGE_EMPTY"), "invalid_argument"],
  ["a caption that is too long", answered(400, "MEDIA_CAPTION_TOO_LONG"), "invalid_argument"],
  ["a refusal of another name", answered(403, "SOMETHING_NEW"), "upstream_error"],
]

describe("an edit Telegram refuses", () => {
  for (const [name, error, code] of REFUSALS) {
    test(`${name} is ${code} with the message unchanged, and the call is not repeated`, async () => {
      fixture.client.setActionAnswer(error)

      const refused = await failure()

      expect(refused).toMatchObject({ code })
      expect(refused.message).toMatch(
        /(the message is unchanged\.|the edit did not happen\. Try again in \d+ seconds\.)$/,
      )
      expect(refused.message).not.toContain("nothing was sent")
      expect(actionsOf(fixture)).toHaveLength(1)
      expect(fixture.pauses).toEqual([])
      unchanged()
    })
  }

  test("says what it was, in words of an edit, with Telegram's name for it", async () => {
    fixture.client.setActionAnswer(answered(400, "MESSAGE_EDIT_TIME_EXPIRED"))

    expect((await failure()).message).toBe(
      "Telegram no longer lets this message be edited (MESSAGE_EDIT_TIME_EXPIRED); the message is unchanged.",
    )
  })

  test("a flood wait says how long to wait", async () => {
    fixture.client.setActionAnswer(answered(420, "FLOOD_WAIT_30"))

    expect((await failure()).message).toBe(
      "Telegram is limiting this account; the edit did not happen. Try again in 30 seconds.",
    )
  })

  test("a connection state of connected alone is no reconnect, so the refusal stands", async () => {
    fixture.client.setActionAnswer(() => {
      fixture.client.onConnectionState.emit("connected")
      return answered(400, "MESSAGE_EDIT_TIME_EXPIRED")
    })

    expect(await failure()).toMatchObject({ code: "forbidden" })
  })
})

describe("an edit whose connection came back during the call", () => {
  for (const [name, error] of REFUSALS) {
    test(`is uncertain even for ${name}`, async () => {
      fixture.client.setActionAnswer(afterReconnect(error))

      const refused = await failure()

      expect(refused).toMatchObject({ code: "uncertain" })
      expect(refused.message).toContain("The edit may have gone through")
      expect(refused.message).toEndWith("Check the message in the chat before editing it again.")
      expect(actionsOf(fixture)).toHaveLength(1)
    })
  }

  test("is judged by the states of its own call only: the next edit's refusal stands again", async () => {
    fixture.client.setActionAnswer(afterReconnect(answered(400, "MESSAGE_EDIT_TIME_EXPIRED")))
    await failure()
    const listening = fixture.client.onConnectionState.length

    fixture.client.setActionAnswer(answered(400, "MESSAGE_EDIT_TIME_EXPIRED"))

    expect(await failure()).toMatchObject({ code: "forbidden" })
    expect(fixture.client.onConnectionState.length).toBe(listening)
  })
})

describe("an edit that may have gone through", () => {
  const others: [string, Error][] = [
    ["mtcute's own timeout", answered(400, "TIMEOUT")],
    ["a server error", answered(500, "INTERNAL")],
    ["a service that is unavailable", answered(-503, "Timeout")],
    ["a redirect", answered(303, "PHONE_MIGRATE_%d")],
    ["an error that is not Telegram's", new Error("socket to +15550100123 broke")],
  ]
  for (const [name, error] of others) {
    test(`${name} is uncertain, with the advice to check the message`, async () => {
      fixture.client.setActionAnswer(error)

      const refused = await failure()

      expect(refused).toMatchObject({ code: "uncertain" })
      expect(refused.message).toEndWith("Check the message in the chat before editing it again.")
      expect(refused.message).not.toContain("15550100123")
      expect(actionsOf(fixture)).toHaveLength(1)
    })
  }

  test("a session that ended is uncertain, and the service ends after the answer", async () => {
    fixture.client.setActionAnswer(answered(401, "SESSION_REVOKED"))

    expect(await failure()).toMatchObject({ code: "uncertain" })
    expect(await outcome).toMatchObject({ status: "logged out" })
  })

  test("an answer without the edited message is uncertain, and stores nothing", async () => {
    fixture.client.setActionAnswer(editedInPrivate(OWN.text + 1, NEW_TEXT))

    expect(await failure()).toMatchObject({ code: "uncertain" })
    unchanged()
  })

  test("an answer of another kind is uncertain", async () => {
    fixture.client.setActionAnswer({ _: "updatesTooLong" })

    expect(await failure()).toMatchObject({ code: "uncertain" })
    unchanged()
  })

  test("never puts the text, the chat or the ids in the log", async () => {
    fixture.client.setActionAnswer(rpcError(400, "TIMEOUT"))
    await failure()

    const log = fixture.logs.join("\n")
    expect(log).toContain("edit failed: TIMEOUT")
    for (const secret of [NEW_TEXT, OWN_TEXT, KEPT, FORUM]) expect(log).not.toContain(secret)
  })
})
