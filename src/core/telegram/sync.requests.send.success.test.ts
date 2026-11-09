import { Long } from "@mtcute/core"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { fakeMessage, fakeUser, messageOf } from "./fake-telegram.testing"
import { storeMessage } from "./ingest-messages"
import { chatRow, messageInput, messageRow, rowsOf } from "./mirror.testing"
import { FORUM, KEPT } from "./sync-requests.testing"
import {
  OPEN_TOPIC,
  SENT_DATE,
  SENT_MS,
  TEXT,
  answerShort,
  forumUpdates,
  privateUpdates,
  seedSendChats,
  send,
  sendsOf,
  shortSent,
} from "./sync-send.testing"
import { START_MS, syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeEach(() => {
  fixture = syncFixture()
})

afterEach(() => fixture.close())

const row = (chat: string, id: number) => fixture.mirror((mirror) => messageRow(mirror, chat, id))
const rowCount = (chat: string, id: number) =>
  fixture.mirror((mirror) => rowsOf(mirror, "SELECT 1 FROM messages WHERE chat = ? AND id = ?", chat, id).length)

describe("a text sent in the short form", () => {
  beforeEach(async () => {
    seedSendChats(fixture)
    await fixture.running()
    answerShort(fixture, 50)
  })

  test("answers with the id and the time, after one call with retries and sleeps off", async () => {
    expect(await send(fixture, { chat: KEPT, text: TEXT })).toEqual({ id: 50, date: SENT_MS })

    const [only, ...rest] = sendsOf(fixture)
    expect(rest).toEqual([])
    expect(only?.options).toMatchObject({ maxRetryCount: 0, floodSleepThreshold: 0 })
    expect(only?.options.abortSignal).toBeInstanceOf(AbortSignal)
    expect(only?.request).toEqual({
      _: "messages.sendMessage",
      peer: { _: "inputPeerUser", userId: Number(KEPT), accessHash: expect.anything() },
      message: TEXT,
      randomId: expect.any(Long),
    })
  })

  test("is recorded in the mirror as the user's own, and moves the chat's newest message", async () => {
    await send(fixture, { chat: KEPT, text: TEXT })

    expect(row(KEPT, 50)).toMatchObject({
      from_me: 1,
      body: TEXT,
      ts: SENT_MS,
      topic: null,
      reply: null,
      kind: "message",
      sender: null,
      edited: null,
    })
    expect(fixture.mirror((mirror) => chatRow(mirror, KEPT))).toMatchObject({ top_id: 50, last_ts: SENT_MS })
  })

  test("with a reply carries the header and is recorded as a reply", async () => {
    await send(fixture, { chat: KEPT, text: TEXT, reply_to: 2 })

    expect(sendsOf(fixture)[0]?.request.replyTo).toEqual({ _: "inputReplyToMessage", replyToMsgId: 2 })
    expect(JSON.parse(String(row(KEPT, 50)?.reply))).toEqual({ id: 2 })
  })

  test("tells mtcute's update state, with a dummy update that moves nothing else", async () => {
    await send(fixture, { chat: KEPT, text: TEXT })

    expect(fixture.client.handled).toEqual([
      {
        update: {
          _: "updates",
          seq: 0,
          date: 0,
          chats: [],
          users: [],
          updates: [{ _: "mtcute.dummyUpdate", channelId: 0, pts: 40, ptsCount: 1 }],
        },
        noDispatch: undefined,
      },
    ])
  })

  test("keeps the entities and the timer Telegram added", async () => {
    const entity = { _: "messageEntityUrl", offset: 0, length: 5 } as const
    fixture.client.setCallAnswer(shortSent(50, { entities: [entity], ttlPeriod: 3600 }))

    await send(fixture, { chat: KEPT, text: "a.com is a link" })

    expect(JSON.parse(String(row(KEPT, 50)?.entities))).toEqual([{ type: "url", offset: 0, length: 5 }])
    expect(row(KEPT, 50)).toMatchObject({ expires: SENT_MS + 3_600_000 })
  })

  test("uses a fresh random id for each send, and one call for each", async () => {
    await send(fixture, { chat: KEPT, text: TEXT })
    await send(fixture, { chat: KEPT, text: TEXT })

    const [first, second] = sendsOf(fixture)
    expect(sendsOf(fixture)).toHaveLength(2)
    expect(first?.request.randomId.eq(second!.request.randomId)).toBe(false)
  })
})

describe("a text sent in an updates group", () => {
  beforeEach(async () => {
    seedSendChats(fixture, { mirrorForum: true })
    fixture.seed((mirror) => {
      storeMessage(mirror, { now: START_MS, keepDisappearing: false }, messageInput({ chat: FORUM, id: 10 }))
    })
    await fixture.running()
  })

  test("in a private chat gives the id and the time and records the message as Telegram returned it", async () => {
    fixture.client.setCallAnswer((call) => privateUpdates(call, 51, 2))

    expect(await send(fixture, { chat: KEPT, text: TEXT, reply_to: 2 })).toEqual({ id: 51, date: SENT_MS })

    expect(row(KEPT, 51)).toMatchObject({ from_me: 1, body: TEXT, ts: SENT_MS, topic: null })
    expect(JSON.parse(String(row(KEPT, 51)?.reply))).toEqual({ id: 2 })
    expect(fixture.client.handled).toHaveLength(1)
    expect(fixture.client.handled[0]).toMatchObject({ update: { _: "updates" }, noDispatch: true })
  })

  test("in a topic records the topic, and a reply within it", async () => {
    fixture.client.setCallAnswer((call) => forumUpdates(call, 60, OPEN_TOPIC, 10))

    expect(await send(fixture, { chat: FORUM, text: TEXT, topic: OPEN_TOPIC, reply_to: 10 })).toEqual({
      id: 60,
      date: SENT_MS,
    })

    expect(sendsOf(fixture)[0]?.request.replyTo).toEqual({
      _: "inputReplyToMessage",
      replyToMsgId: 10,
      topMsgId: OPEN_TOPIC,
    })
    expect(row(FORUM, 60)).toMatchObject({ from_me: 1, body: TEXT, topic: OPEN_TOPIC })
    expect(JSON.parse(String(row(FORUM, 60)?.reply))).toEqual({ id: 10, topic: OPEN_TOPIC })
  })

  test("in a topic without a reply is a post to the topic, not a reply", async () => {
    fixture.client.setCallAnswer((call) => forumUpdates(call, 61, OPEN_TOPIC))

    await send(fixture, { chat: FORUM, text: TEXT, topic: OPEN_TOPIC })

    expect(sendsOf(fixture)[0]?.request.replyTo).toEqual({
      _: "inputReplyToMessage",
      replyToMsgId: OPEN_TOPIC,
      topMsgId: OPEN_TOPIC,
    })
    expect(row(FORUM, 61)).toMatchObject({ topic: OPEN_TOPIC, reply: null })
  })

  test("an update for the same message later is an upsert, not a second row", async () => {
    fixture.client.setCallAnswer((call) => privateUpdates(call, 51))
    await send(fixture, { chat: KEPT, text: TEXT })

    const echo = fakeMessage({ id: 51, out: true, fromId: undefined, message: TEXT, date: SENT_DATE })
    fixture.client.onNewMessage.emit(messageOf(echo, fakeUser()))

    expect(rowCount(KEPT, 51)).toBe(1)
  })
})

describe("a mirror that cannot be written", () => {
  test("does not turn the send that went out into a failure, and then stops the service", async () => {
    seedSendChats(fixture)
    const { outcome } = await fixture.running()
    answerShort(fixture, 50)
    fixture.seed((mirror) =>
      mirror.exec("CREATE TRIGGER refuse BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'no'); END"),
    )

    expect(await send(fixture, { chat: KEPT, text: TEXT })).toEqual({ id: 50, date: SENT_MS })

    expect(await outcome).toMatchObject({ exitCode: 1, status: "failed" })
    expect(sendsOf(fixture)).toHaveLength(1)
  })
})
