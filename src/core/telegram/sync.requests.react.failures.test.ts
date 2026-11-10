import { tl } from "@mtcute/core"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failureOf } from "./service.testing"
import { answered, type FakeActionScript } from "./sync-client-send.testing"
import { KEPT } from "./sync-requests.testing"
import { actionsOf } from "./sync-action.testing"
import { PARTY, REACTED, THUMBS, react, reactionsStored, seedReactionChats } from "./sync-react.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture
let outcome: Awaited<ReturnType<SyncFixture["running"]>>["outcome"]

beforeEach(async () => {
  fixture = syncFixture()
  seedReactionChats(fixture)
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

const failure = () => failureOf(react(fixture, { chat: KEPT, id: REACTED.mine, emoji: PARTY }))

const unchanged = () =>
  expect(reactionsStored(fixture, KEPT, REACTED.mine)).toEqual([
    { emoji: THUMBS, count: 2, mine: true },
    { emoji: PARTY, count: 1 },
  ])

const REFUSALS: [string, tl.RpcError, string][] = [
  ["a flood wait", answered(420, "FLOOD_WAIT_30"), "rate_limited"],
  ["a reaction Telegram does not take", answered(400, "REACTION_INVALID"), "invalid_argument"],
  ["an empty reaction", answered(400, "REACTION_EMPTY"), "invalid_argument"],
  ["too many reactions", answered(400, "REACTIONS_TOO_MANY"), "forbidden"],
  ["a reaction that needs Premium", answered(403, "PREMIUM_ACCOUNT_REQUIRED"), "forbidden"],
  ["a chat that needs an admin", answered(403, "CHAT_ADMIN_REQUIRED"), "forbidden"],
  ["a chat that does not take writes", answered(403, "CHAT_WRITE_FORBIDDEN"), "forbidden"],
  ["a message that is gone", answered(400, "MESSAGE_ID_INVALID"), "not_found"],
  ["a message id Telegram does not know", answered(400, "MSG_ID_INVALID"), "not_found"],
  ["a chat that is gone", answered(400, "PEER_ID_INVALID"), "not_found"],
  ["a refusal of another name", answered(403, "SOMETHING_NEW"), "upstream_error"],
]

describe("a reaction Telegram refuses", () => {
  for (const [name, error, code] of REFUSALS) {
    test(`${name} is ${code} with the reaction unchanged, and the call is not repeated`, async () => {
      fixture.client.setActionAnswer(error)

      const refused = await failure()

      expect(refused).toMatchObject({ code })
      expect(refused.message).toMatch(
        /(the reaction is unchanged\.|the reaction did not happen\. Try again in \d+ seconds\.)$/,
      )
      expect(actionsOf(fixture)).toHaveLength(1)
      expect(fixture.pauses).toEqual([])
      unchanged()
    })
  }

  test("says what it was, in words of a reaction, with Telegram's name for it", async () => {
    fixture.client.setActionAnswer(answered(400, "REACTION_INVALID"))

    expect((await failure()).message).toBe(
      "Telegram does not take this reaction here (REACTION_INVALID); the reaction is unchanged.",
    )
  })

  test("a refusal for lack of permission says the account may not react there", async () => {
    fixture.client.setActionAnswer(answered(403, "CHAT_WRITE_FORBIDDEN"))

    expect((await failure()).message).toBe(
      "Telegram does not let this account react here (CHAT_WRITE_FORBIDDEN); the reaction is unchanged.",
    )
  })
})

describe("a reaction whose connection came back during the call", () => {
  for (const [name, error] of REFUSALS) {
    test(`is uncertain even for ${name}`, async () => {
      fixture.client.setActionAnswer(afterReconnect(error))

      const refused = await failure()

      expect(refused).toMatchObject({ code: "uncertain" })
      expect(refused.message).toContain("The reaction may have gone through")
      expect(refused.message).toEndWith("Check the message in the chat before changing it again.")
      expect(actionsOf(fixture)).toHaveLength(1)
      unchanged()
    })
  }
})

describe("a reaction that may have gone through", () => {
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
      unchanged()
    })
  }

  test("a session that ended is uncertain, and the service ends after the answer", async () => {
    fixture.client.setActionAnswer(answered(401, "SESSION_REVOKED"))

    expect(await failure()).toMatchObject({ code: "uncertain" })
    expect(await outcome).toMatchObject({ status: "logged out" })
  })
})
