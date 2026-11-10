import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { CHANNEL } from "./mirror.testing"
import { failureOf } from "./service.testing"
import { FORUM, KEPT, PLAIN, UNLISTED } from "./sync-requests.testing"
import { LEFT_GROUP } from "./sync-send.testing"
import { OWN, OWN_IN_FORUM, THEIRS, actionsOf } from "./sync-action.testing"
import { BOT_CHAT, IN_OTHER_CHAT, SAVED, pin, pinnedAnswer, seedPinChats } from "./sync-pin.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeEach(async () => {
  fixture = syncFixture()
  seedPinChats(fixture)
  await fixture.running()
  fixture.client.setActionAnswer(pinnedAnswer(THEIRS))
})

afterEach(() => fixture.close())

const refused = (params: Record<string, unknown>) => failureOf(pin(fixture, { chat: KEPT, id: THEIRS, ...params }))

/** A refusal before the call leaves no trace at Telegram: the peer is not even resolved. */
const nothingAsked = () => {
  expect(actionsOf(fixture)).toEqual([])
  expect(fixture.client.argsOf("resolvePeer")).toEqual([])
}

describe("a pin the mirror shows cannot succeed", () => {
  test("in a chat it does not list is not found", async () => {
    expect(await refused({ chat: UNLISTED })).toMatchObject({ code: "not_found" })
    nothingAsked()
  })

  test("in a channel is not found while channels are off", async () => {
    expect(await refused({ chat: CHANNEL })).toMatchObject({ code: "not_found" })
    nothingAsked()
  })

  test("in a chat the account left is forbidden, and the answer says nothing was pinned", async () => {
    expect(await refused({ chat: LEFT_GROUP })).toMatchObject({
      code: "forbidden",
      message: "You are no longer in this chat; nothing was pinned.",
    })
    nothingAsked()
  })

  test("of an unpin says nothing was unpinned", async () => {
    expect(await refused({ chat: LEFT_GROUP, unpin: true })).toMatchObject({
      message: "You are no longer in this chat; nothing was unpinned.",
    })
    nothingAsked()
  })

  test("of a message the mirror lacks is not found", async () => {
    expect(await refused({ id: 77 })).toMatchObject({
      code: "not_found",
      message: "No message 77 in this chat; nothing was pinned.",
    })
    nothingAsked()
  })

  test("of a message in a chat the mirror does not keep is not found, since it holds no messages to check", async () => {
    expect(await refused({ chat: PLAIN })).toMatchObject({ code: "not_found" })
    nothingAsked()
  })

  test("of a message deleted for everyone is not found", async () => {
    expect(await refused({ id: OWN.deleted })).toMatchObject({
      code: "not_found",
      message: "This message was deleted; nothing was pinned.",
    })
    nothingAsked()
  })

  test("of an unpin of a deleted message is not found too", async () => {
    expect(await refused({ id: OWN.deleted, unpin: true })).toMatchObject({ code: "not_found" })
    nothingAsked()
  })
})

describe("a pin for both sides", () => {
  for (const [name, chat, id] of [
    ["a supergroup", FORUM, OWN_IN_FORUM],
    ["Saved Messages", SAVED, IN_OTHER_CHAT],
  ] as const) {
    test(`in ${name} is invalid, with nothing asked`, async () => {
      expect(await refused({ chat, id, both_sides: true })).toMatchObject({
        code: "invalid_argument",
        message: "A pin can be made for both sides only in a chat with a person or a bot; nothing was pinned.",
      })
      nothingAsked()
    })
  }

  test("is allowed in a chat with a person and in a chat with a bot", async () => {
    await pin(fixture, { chat: KEPT, id: THEIRS, both_sides: true })
    await pin(fixture, { chat: BOT_CHAT, id: IN_OTHER_CHAT, both_sides: true })

    expect(actionsOf(fixture)).toHaveLength(2)
  })

  test("is no reason to refuse a pin without it in a supergroup", async () => {
    await pin(fixture, { chat: FORUM, id: OWN_IN_FORUM })

    expect(actionsOf(fixture)).toHaveLength(1)
  })
})
