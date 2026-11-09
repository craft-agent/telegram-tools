import { MtPeerNotFoundError } from "@mtcute/core"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { deleteMessages } from "./ingest-delete"
import { floodWait } from "./login.testing"
import { CHANNEL } from "./mirror.testing"
import { failureOf } from "./service.testing"
import { FORUM, KEPT, PLAIN, UNLISTED } from "./sync-requests.testing"
import {
  CLOSED_TOPIC,
  LEFT_GROUP,
  MUTED_CHAT,
  OPEN_TOPIC,
  TEXT,
  answerShort,
  seedSendChats,
  send,
  sendsOf,
} from "./sync-send.testing"
import { START_MS, syncFixture, type SyncFixture } from "./sync.testing"
import { answered } from "./sync-client-send.testing"

let fixture: SyncFixture

beforeAll(async () => {
  fixture = syncFixture()
  seedSendChats(fixture)
  fixture.seed((mirror) => deleteMessages(mirror, { now: START_MS, keepDisappearing: false }, { chat: KEPT, ids: [3] }))
  await fixture.running()
})

afterAll(() => fixture.close())

beforeEach(() => {
  fixture.client.calls.length = 0
  answerShort(fixture, 50)
})

const refused = (params: Record<string, unknown>) => failureOf(send(fixture, { text: TEXT, ...params }))

/** The refusal leaves no trace at Telegram: the peer is not even resolved. */
const nothingAsked = () => {
  expect(sendsOf(fixture)).toEqual([])
  expect(fixture.client.argsOf("resolvePeer")).toEqual([])
}

describe("a chat the mirror shows cannot be sent to", () => {
  test("a chat it does not list is not found", async () => {
    expect(await refused({ chat: UNLISTED })).toMatchObject({ code: "not_found" })
    nothingAsked()
  })

  test("a channel is not found while channels are off", async () => {
    expect(await refused({ chat: CHANNEL })).toMatchObject({ code: "not_found" })
    nothingAsked()
  })

  test("a chat the account left is forbidden, and the answer says nothing was sent", async () => {
    expect(await refused({ chat: LEFT_GROUP })).toMatchObject({
      code: "forbidden",
      message: "You are no longer in this chat; nothing was sent.",
    })
    nothingAsked()
  })

  test("a chat the account is known not to be able to write in is forbidden", async () => {
    expect(await refused({ chat: MUTED_CHAT })).toMatchObject({ code: "forbidden" })
    nothingAsked()
  })
})

describe("a topic", () => {
  test("is refused in a chat without topics", async () => {
    for (const chat of [PLAIN, KEPT]) {
      expect(await refused({ chat, topic: OPEN_TOPIC })).toMatchObject({ code: "invalid_argument" })
    }
    nothingAsked()
  })

  test("the mirror keeps closed is sent to, since an admin may post there and Telegram decides", async () => {
    await send(fixture, { chat: FORUM, text: TEXT, topic: CLOSED_TOPIC })

    expect(sendsOf(fixture).map(({ request }) => request.replyTo)).toEqual([
      { _: "inputReplyToMessage", replyToMsgId: CLOSED_TOPIC, topMsgId: CLOSED_TOPIC },
    ])
  })

  test("that Telegram answers TOPIC_CLOSED for is forbidden, with nothing sent", async () => {
    fixture.client.setCallAnswer(answered(403, "TOPIC_CLOSED"))

    const failure = await refused({ chat: FORUM, topic: CLOSED_TOPIC })

    expect(failure).toMatchObject({ code: "forbidden" })
    expect(failure.message).toContain("nothing was sent")
    expect(sendsOf(fixture)).toHaveLength(1)
  })

  test("that is open, or that the mirror does not know, is sent to", async () => {
    await send(fixture, { chat: FORUM, text: TEXT, topic: OPEN_TOPIC })
    await send(fixture, { chat: FORUM, text: TEXT, topic: 99 })

    expect(sendsOf(fixture).map(({ request }) => request.replyTo)).toEqual([
      { _: "inputReplyToMessage", replyToMsgId: OPEN_TOPIC, topMsgId: OPEN_TOPIC },
      { _: "inputReplyToMessage", replyToMsgId: 99, topMsgId: 99 },
    ])
  })

  test("that is General sends with no reply header", async () => {
    await send(fixture, { chat: FORUM, text: TEXT, topic: 1 })

    expect(sendsOf(fixture)).toHaveLength(1)
    expect(sendsOf(fixture)[0]?.request).not.toHaveProperty("replyTo")
  })

  test("that is General and a reply names the message only", async () => {
    await send(fixture, { chat: FORUM, text: TEXT, topic: 1, reply_to: 12 })

    expect(sendsOf(fixture)[0]?.request.replyTo).toEqual({ _: "inputReplyToMessage", replyToMsgId: 12 })
  })
})

describe("a reply in a chat the mirror keeps", () => {
  test("to a message it holds is sent", async () => {
    await send(fixture, { chat: KEPT, text: TEXT, reply_to: 2 })

    expect(sendsOf(fixture)[0]?.request.replyTo).toEqual({ _: "inputReplyToMessage", replyToMsgId: 2 })
  })

  test("to a message it lacks is not found, and nothing is sent", async () => {
    expect(await refused({ chat: KEPT, reply_to: 77 })).toMatchObject({
      code: "not_found",
      message: "No message 77 in this chat to reply to; nothing was sent.",
    })
    nothingAsked()
  })

  test("to a message deleted for everyone is not found, and nothing is sent", async () => {
    expect(await refused({ chat: KEPT, reply_to: 3 })).toMatchObject({ code: "not_found" })
    nothingAsked()
  })
})

describe("a reply in a chat the mirror does not keep", () => {
  test("is sent, since Telegram decides", async () => {
    await send(fixture, { chat: PLAIN, text: TEXT, reply_to: 123 })

    expect(sendsOf(fixture)).toHaveLength(1)
    expect(sendsOf(fixture)[0]?.request.replyTo).toEqual({ _: "inputReplyToMessage", replyToMsgId: 123 })
  })
})

describe("a chat Telegram cannot give", () => {
  test("is not found when its peer is unknown, and nothing is sent", async () => {
    fixture.client.fail("resolvePeer", new MtPeerNotFoundError("peer not cached"))

    expect(await refused({ chat: KEPT })).toMatchObject({ code: "not_found" })
    expect(sendsOf(fixture)).toEqual([])
  })

  test("is refused as Telegram refuses a read when resolving it fails, with nothing sent", async () => {
    fixture.client.fail("resolvePeer", floodWait(42))

    expect(await refused({ chat: KEPT })).toMatchObject({
      code: "upstream_error",
      message: "Telegram is limiting requests from this account; try again in 42 seconds.",
    })
    expect(sendsOf(fixture)).toEqual([])
  })
})

describe("a channel while channels are on", () => {
  test("is sent to like any chat the mirror lists", async () => {
    const channels = syncFixture()
    seedSendChats(channels)
    await channels.running({ channels: true })
    answerShort(channels, 8)

    try {
      expect(await send(channels, { chat: CHANNEL, text: TEXT })).toMatchObject({ id: 8 })
    } finally {
      await channels.close()
    }
  })
})
