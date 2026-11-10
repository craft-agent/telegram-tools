import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { THEIRS, actionsOf, affected } from "./sync-action.testing"
import {
  IN_FORUM,
  KEPT_UNREAD,
  NEWER,
  OWN_NEWEST,
  markRead,
  readStateOf,
  seedMarkReadChats,
  storedIdsOf,
} from "./sync-mark-read.testing"
import { FORUM, KEPT } from "./sync-requests.testing"
import { OPEN_TOPIC, STORED_IDS } from "./sync-send.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeEach(async () => {
  fixture = syncFixture()
  seedMarkReadChats(fixture)
  await fixture.running()
  fixture.client.setActionAnswer(affected(1, 60))
})

afterEach(() => fixture.close())

const request = () => actionsOf(fixture)[0]?.request
const user = { _: "inputPeerUser" as const, userId: Number(KEPT), accessHash: expect.anything() }
const channel = { _: "inputPeerChannel" as const, channelId: expect.any(Number), accessHash: expect.anything() }
const FORUM_UNREAD = Object.keys(IN_FORUM).length

describe("a read mark Telegram accepts", () => {
  test("in a private chat is one messages.readHistory, with retries and sleeps off", async () => {
    expect(await markRead(fixture, { chat: KEPT, up_to: NEWER[1] })).toEqual({ chat: KEPT, up_to: NEWER[1] })

    const [only, ...rest] = actionsOf(fixture)
    expect(rest).toEqual([])
    expect(only?.options).toMatchObject({ maxRetryCount: 0, floodSleepThreshold: 0 })
    expect(only?.options.abortSignal).toBeInstanceOf(AbortSignal)
    expect(only?.request).toEqual({ _: "messages.readHistory", peer: user, maxId: NEWER[1] })
    expect(fixture.pauses).toEqual([])
  })

  test("in a private chat tells mtcute's update state of the events it counted, for the account's own", async () => {
    await markRead(fixture, { chat: KEPT, up_to: NEWER[1] })

    expect(fixture.client.handled).toEqual([
      {
        update: expect.objectContaining({
          _: "updates",
          updates: [{ _: "mtcute.dummyUpdate", channelId: 0, pts: 60, ptsCount: 1 }],
        }),
        noDispatch: undefined,
      },
    ])
  })

  test("in a supergroup is one channels.readHistory, which answers a bool and needs no hand-over", async () => {
    fixture.client.setActionAnswer(true)

    expect(await markRead(fixture, { chat: FORUM, up_to: IN_FORUM.open })).toEqual({
      chat: FORUM,
      up_to: IN_FORUM.open,
    })

    expect(request()).toEqual({
      _: "channels.readHistory",
      channel: { _: "inputChannel", channelId: expect.any(Number), accessHash: expect.anything() },
      maxId: IN_FORUM.open,
    })
    expect(actionsOf(fixture)).toHaveLength(1)
    expect(fixture.client.handled).toEqual([])
  })

  test("for a topic is one messages.readDiscussion of the topic, whose answer is a bool too", async () => {
    fixture.client.setActionAnswer(true)

    expect(await markRead(fixture, { chat: FORUM, up_to: IN_FORUM.open, topic: OPEN_TOPIC })).toEqual({
      chat: FORUM,
      up_to: IN_FORUM.open,
      topic: OPEN_TOPIC,
    })

    expect(request()).toEqual({
      _: "messages.readDiscussion",
      peer: channel,
      msgId: OPEN_TOPIC,
      readMaxId: IN_FORUM.open,
    })
    expect(fixture.client.handled).toEqual([])
  })

  test("for the General topic names its id, which is 1", async () => {
    fixture.client.setActionAnswer(true)

    await markRead(fixture, { chat: FORUM, up_to: IN_FORUM.general, topic: 1 })

    expect(request()).toEqual({ _: "messages.readDiscussion", peer: channel, msgId: 1, readMaxId: IN_FORUM.general })
  })

  test("in a private chat is done too when the answer is a bool, with nothing to hand over", async () => {
    fixture.client.setActionAnswer(true)

    expect(await markRead(fixture, { chat: KEPT, up_to: THEIRS })).toEqual({ chat: KEPT, up_to: THEIRS })
    expect(fixture.client.handled).toEqual([])
  })

  test("is no reason to fail when mtcute's update state cannot take the events", async () => {
    fixture.client.fail("handleClientUpdate", new Error("state of +15550100123 broke"))

    expect(await markRead(fixture, { chat: KEPT, up_to: NEWER[1] })).toEqual({ chat: KEPT, up_to: NEWER[1] })
    expect(readStateOf(fixture, KEPT).read_max).toBe(NEWER[1])
  })
})

describe("the mirror after a read mark", () => {
  test("holds the new read mark and the messages of others past it as unread", async () => {
    expect(readStateOf(fixture, KEPT)).toEqual({ read_max: null, unread: KEPT_UNREAD })

    await markRead(fixture, { chat: KEPT, up_to: STORED_IDS.length })

    expect(readStateOf(fixture, KEPT)).toEqual({ read_max: STORED_IDS.length, unread: NEWER.length })
  })

  test("goes on from there: a later mark moves it forward, never back", async () => {
    await markRead(fixture, { chat: KEPT, up_to: NEWER[1] })
    expect(readStateOf(fixture, KEPT)).toEqual({ read_max: NEWER[1], unread: 1 })

    await markRead(fixture, { chat: KEPT, up_to: NEWER[0] })

    expect(readStateOf(fixture, KEPT)).toEqual({ read_max: NEWER[1], unread: 1 })
    expect(actionsOf(fixture)).toHaveLength(1)
  })

  test("counts none of the user's own messages, and none at all up to the newest", async () => {
    await markRead(fixture, { chat: KEPT, up_to: NEWER[2] })
    expect(readStateOf(fixture, KEPT)).toEqual({ read_max: NEWER[2], unread: 0 })

    await markRead(fixture, { chat: KEPT, up_to: OWN_NEWEST })
    expect(readStateOf(fixture, KEPT)).toEqual({ read_max: OWN_NEWEST, unread: 0 })
  })

  test("of a supergroup is moved the same way", async () => {
    fixture.client.setActionAnswer(true)

    await markRead(fixture, { chat: FORUM, up_to: IN_FORUM.open })

    expect(readStateOf(fixture, FORUM)).toEqual({ read_max: IN_FORUM.open, unread: FORUM_UNREAD - 2 })
  })

  test("is untouched by a topic's read mark, which the mirror has no state for", async () => {
    fixture.client.setActionAnswer(true)

    await markRead(fixture, { chat: FORUM, up_to: IN_FORUM.open, topic: OPEN_TOPIC })

    expect(readStateOf(fixture, FORUM)).toEqual({ read_max: null, unread: FORUM_UNREAD })
  })

  test("keeps every message it holds", async () => {
    const before = storedIdsOf(fixture, KEPT)

    await markRead(fixture, { chat: KEPT, up_to: NEWER[1] })

    expect(storedIdsOf(fixture, KEPT)).toEqual(before)
  })
})
