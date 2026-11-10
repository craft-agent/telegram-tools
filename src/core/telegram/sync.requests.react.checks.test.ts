import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { CHANNEL } from "./mirror.testing"
import { failureOf } from "./service.testing"
import { KEPT, PLAIN, UNLISTED } from "./sync-requests.testing"
import { LEFT_GROUP } from "./sync-send.testing"
import { OWN, actionsOf } from "./sync-action.testing"
import { PARTY, REACTED, THUMBS, react, reactedAnswer, seedReactionChats } from "./sync-react.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeEach(async () => {
  fixture = syncFixture()
  seedReactionChats(fixture)
  await fixture.running()
  fixture.client.setActionAnswer(reactedAnswer(REACTED.others, []))
})

afterEach(() => fixture.close())

const refused = (params: Record<string, unknown>) =>
  failureOf(react(fixture, { chat: KEPT, id: REACTED.others, emoji: THUMBS, ...params }))

/** A refusal before the call leaves no trace at Telegram: the peer is not even resolved. */
const nothingAsked = () => {
  expect(actionsOf(fixture)).toEqual([])
  expect(fixture.client.argsOf("resolvePeer")).toEqual([])
}

describe("a reaction the mirror shows cannot succeed", () => {
  test("in a chat it does not list is not found", async () => {
    expect(await refused({ chat: UNLISTED })).toMatchObject({ code: "not_found" })
    nothingAsked()
  })

  test("in a channel is not found while channels are off", async () => {
    expect(await refused({ chat: CHANNEL })).toMatchObject({ code: "not_found" })
    nothingAsked()
  })

  test("in a chat the account left is forbidden, and the answer says nothing was changed", async () => {
    expect(await refused({ chat: LEFT_GROUP })).toMatchObject({
      code: "forbidden",
      message: "You are no longer in this chat; nothing was changed.",
    })
    nothingAsked()
  })

  test("on a message the mirror lacks is not found", async () => {
    expect(await refused({ id: 77 })).toMatchObject({
      code: "not_found",
      message: "No message 77 in this chat; nothing was changed.",
    })
    nothingAsked()
  })

  test("on a message in a chat the mirror does not keep is not found, since it holds no messages to check", async () => {
    expect(await refused({ chat: PLAIN })).toMatchObject({ code: "not_found" })
    nothingAsked()
  })

  test("on a message deleted for everyone is not found", async () => {
    expect(await refused({ id: OWN.deleted })).toMatchObject({
      code: "not_found",
      message: "This message was deleted; nothing was changed.",
    })
    nothingAsked()
  })

  test("removed, on a message the mirror lacks is not found", async () => {
    expect(await failureOf(react(fixture, { chat: KEPT, id: 77, remove: true }))).toMatchObject({ code: "not_found" })
    nothingAsked()
  })
})

describe("a reaction on a message of anyone", () => {
  test("is allowed on a message someone else wrote and on the user's own", async () => {
    for (const id of [REACTED.others, OWN.text]) {
      expect(await react(fixture, { chat: KEPT, id, emoji: PARTY })).toEqual({ id, emoji: PARTY })
    }
    expect(actionsOf(fixture)).toHaveLength(2)
  })
})

describe("an emoji the mirror shows as the user's own", () => {
  test("is done without a call, and says it was done already", async () => {
    expect(await react(fixture, { chat: KEPT, id: REACTED.mine, emoji: THUMBS })).toEqual({
      id: REACTED.mine,
      emoji: THUMBS,
      already: true,
    })
    nothingAsked()
  })

  test("is done without a call when it is the only reaction of the user", async () => {
    expect(await react(fixture, { chat: KEPT, id: REACTED.only, emoji: THUMBS })).toMatchObject({ already: true })
    nothingAsked()
  })

  test("is not skipped for another emoji of the message that is not the user's", async () => {
    await react(fixture, { chat: KEPT, id: REACTED.mine, emoji: PARTY })

    expect(actionsOf(fixture)).toHaveLength(1)
  })

  test("is not skipped for the emoji of others, which the user did not choose", async () => {
    await react(fixture, { chat: KEPT, id: REACTED.others, emoji: PARTY })

    expect(actionsOf(fixture)).toHaveLength(1)
  })

  test("is no reason to skip a removal, since the mirror may be behind", async () => {
    await react(fixture, { chat: KEPT, id: REACTED.others, remove: true })
    await react(fixture, { chat: KEPT, id: REACTED.none, remove: true })

    expect(actionsOf(fixture)).toHaveLength(2)
  })
})
