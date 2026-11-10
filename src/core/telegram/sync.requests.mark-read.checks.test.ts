import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { applyRead } from "./ingest-chats"
import { CHANNEL } from "./mirror.testing"
import { failureOf } from "./service.testing"
import { OWN, THEIRS, actionsOf, affected } from "./sync-action.testing"
import { IN_FORUM, NEWER, markRead, readStateOf, seedMarkReadChats } from "./sync-mark-read.testing"
import { FORUM, KEPT, PLAIN, UNLISTED } from "./sync-requests.testing"
import { LEFT_GROUP, OPEN_TOPIC, STORED_IDS } from "./sync-send.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"

/** Where the seeded chat is read to: the last of Alice's first messages. */
const READ_TO = STORED_IDS.length

/** Where the forum supergroup is read to: past every message of it. */
const FORUM_READ_TO = 90

let fixture: SyncFixture

beforeEach(async () => {
  fixture = syncFixture()
  seedMarkReadChats(fixture)
  fixture.seed((mirror) => {
    applyRead(mirror, { chat: KEPT, maxId: READ_TO, unread: NEWER.length })
    applyRead(mirror, { chat: FORUM, maxId: FORUM_READ_TO, unread: 0 })
  })
  await fixture.running()
  fixture.client.setActionAnswer(affected())
})

afterEach(() => fixture.close())

const refused = (params: Record<string, unknown>) =>
  failureOf(markRead(fixture, { chat: KEPT, up_to: NEWER[0], ...params }))

/** A refusal before the call leaves no trace at Telegram: the peer is not even resolved. */
const nothingAsked = () => {
  expect(actionsOf(fixture)).toEqual([])
  expect(fixture.client.argsOf("resolvePeer")).toEqual([])
}

describe("a read mark the mirror shows cannot succeed", () => {
  test("in a chat it does not list is not found", async () => {
    expect(await refused({ chat: UNLISTED })).toMatchObject({ code: "not_found" })
    nothingAsked()
  })

  test("in a channel is not found while channels are off", async () => {
    expect(await refused({ chat: CHANNEL })).toMatchObject({ code: "not_found" })
    nothingAsked()
  })

  test("in a chat the account left is forbidden, and the answer says nothing was marked read", async () => {
    expect(await refused({ chat: LEFT_GROUP })).toMatchObject({
      code: "forbidden",
      message: "You are no longer in this chat; nothing was marked read.",
    })
    nothingAsked()
  })

  test("up to a message the mirror lacks is not found", async () => {
    expect(await refused({ up_to: 77 })).toMatchObject({
      code: "not_found",
      message: "No message 77 in this chat; nothing was marked read.",
    })
    nothingAsked()
  })

  test("in a chat the mirror does not keep is not found, since it holds no messages to check", async () => {
    expect(await refused({ chat: PLAIN })).toMatchObject({
      code: "not_found",
      message: "This chat is not mirrored, so its messages cannot be checked; nothing was marked read.",
    })
    nothingAsked()
  })

  test("up to a message deleted for everyone is not found", async () => {
    expect(await refused({ up_to: OWN.deleted })).toMatchObject({
      code: "not_found",
      message: "This message was deleted; nothing was marked read.",
    })
    nothingAsked()
  })

  test("of a topic in a chat without topics is invalid", async () => {
    expect(await refused({ topic: OPEN_TOPIC })).toMatchObject({
      code: "invalid_argument",
      message: "This chat has no topics; nothing was marked read.",
    })
    nothingAsked()
  })

  test("of a topic up to a message of another topic is invalid", async () => {
    expect(await refused({ chat: FORUM, up_to: IN_FORUM.closed, topic: OPEN_TOPIC })).toMatchObject({
      code: "invalid_argument",
      message: "This message is not in that topic; nothing was marked read.",
    })
    nothingAsked()
  })

  test("of a topic up to a message of the General topic is invalid, and of the General topic up to another one's", async () => {
    expect(await refused({ chat: FORUM, up_to: IN_FORUM.general, topic: OPEN_TOPIC })).toMatchObject({
      code: "invalid_argument",
    })
    expect(await refused({ chat: FORUM, up_to: IN_FORUM.open, topic: 1 })).toMatchObject({
      code: "invalid_argument",
    })
    nothingAsked()
  })
})

describe("a read mark the mirror shows is allowed", () => {
  test("up to the user's own message, which anyone's may be", async () => {
    expect(await markRead(fixture, { chat: KEPT, up_to: OWN.text })).toEqual({ chat: KEPT, up_to: OWN.text })
    expect(actionsOf(fixture)).toHaveLength(1)
  })

  test("of the General topic up to a message of it, which the mirror keeps with no topic", async () => {
    fixture.client.setActionAnswer(true)

    expect(await markRead(fixture, { chat: FORUM, up_to: IN_FORUM.general, topic: 1 })).toEqual({
      chat: FORUM,
      up_to: IN_FORUM.general,
      topic: 1,
    })
    expect(actionsOf(fixture)).toHaveLength(1)
  })
})

describe("a chat the mirror shows read up to the message or beyond", () => {
  test.each([
    ["up to it", READ_TO],
    ["beyond it", THEIRS],
  ])("is done %s, without a call", async (_, upTo) => {
    expect(await markRead(fixture, { chat: KEPT, up_to: upTo })).toEqual({ chat: KEPT, up_to: upTo, already: true })
    nothingAsked()
    expect(readStateOf(fixture, KEPT)).toEqual({ read_max: READ_TO, unread: NEWER.length })
  })

  test("is checked first: a message the mirror lacks is refused even below the read mark", async () => {
    expect(await refused({ chat: FORUM, up_to: 77 })).toMatchObject({ code: "not_found" })
    nothingAsked()
  })

  test("has no read mark for a topic to be judged by, so a topic is asked for", async () => {
    fixture.client.setActionAnswer(true)

    expect(await markRead(fixture, { chat: FORUM, up_to: IN_FORUM.open, topic: OPEN_TOPIC })).toEqual({
      chat: FORUM,
      up_to: IN_FORUM.open,
      topic: OPEN_TOPIC,
    })
    expect(actionsOf(fixture)).toHaveLength(1)
  })
})
