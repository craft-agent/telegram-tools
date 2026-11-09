import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Chat, DeleteMessageUpdate, User } from "@mtcute/core"
import type { tl } from "@mtcute/core"
import {
  FAKE_DATE,
  FAKE_IDS,
  FAKE_MARKED,
  FAKE_PRIVATE_VALUES,
  channelPeer,
  fakeDeleteUpdate,
  fakeMessage,
  fakeReactions,
  fakeReplyHeader,
  fakeServiceMessage,
  fakeSupergroup,
  fakeUser,
  messageOf,
  userPeer,
} from "./fake-telegram.testing"
import { fakePhotoMedia, fakeViewOncePhotoMedia } from "./fake-telegram-media.testing"
import { chatInputOf, deleteInputOf, messageInputOf } from "./from-mtcute"
import { deleteMessages } from "./ingest-delete"
import { setFollowed, upsertChats } from "./ingest-chats"
import { storeMessage } from "./ingest-messages"
import type { ChatInput, MessageInput } from "./mirror-input"
import { NOW, columnOf, createTestMirror, messageRow, rowsOf, type TestMirror } from "./mirror.testing"

const MS = 1000
const alice = fakeUser()

let t: TestMirror

beforeEach(() => {
  t = createTestMirror()
  const chat = chatInputOf(new User(alice)) as ChatInput
  upsertChats(t.mirror, [chat], NOW)
  setFollowed(t.mirror, chat.id, true)
})

afterEach(() => {
  t.close()
})

function store(raw: tl.TypeMessage = fakeMessage(), now = NOW) {
  const input = messageInputOf(messageOf(raw, alice)) as MessageInput
  return storeMessage(t.mirror, t.ctx(now), input)
}

describe("a message made from mtcute objects, stored", () => {
  test("lands in the mirror with everything the adapter read", () => {
    const raw = fakeMessage({
      id: 7,
      message: "see this",
      media: fakePhotoMedia({ spoiler: true }),
      replyTo: fakeReplyHeader({ replyToMsgId: 3 }),
      reactions: fakeReactions({ emoji: "👍", count: 2, chosen: 0 }),
    })
    expect(store(raw)).toBe("stored")
    expect(messageRow(t.mirror, FAKE_MARKED.alice, 7)).toMatchObject({
      chat: FAKE_MARKED.alice,
      id: 7,
      topic: null,
      ts: FAKE_DATE * MS,
      from_me: 0,
      sender: FAKE_MARKED.alice,
      sender_name: "Alice Example",
      kind: "message",
      body: "see this",
      media: '{"type":"photo","mime":"image/jpeg","size":123456,"width":800,"height":600,"spoiler":true}',
      reply: '{"id":3}',
      reactions: '[{"emoji":"👍","count":2,"mine":true}]',
      view_once: 0,
      self_destruct: null,
    })
  })

  test("moves the chat's newest message forward", () => {
    store(fakeMessage({ id: 7 }))
    expect(rowsOf(t.mirror, "SELECT top_id, last_ts FROM chats")).toEqual([{ top_id: 7, last_ts: FAKE_DATE * MS }])
  })

  test("stores a service message with its action", () => {
    const raw = fakeServiceMessage({ _: "messageActionSetMessagesTTL", period: 604_800 }, { id: 8 })
    expect(store(raw)).toBe("stored")
    expect(messageRow(t.mirror, FAKE_MARKED.alice, 8)).toMatchObject({
      kind: "service",
      body: null,
      action: '{"type":"ttl_changed","period":604800}',
    })
  })

  test("stores a view-once photo as view-once", () => {
    store(fakeMessage({ id: 9, media: fakeViewOncePhotoMedia() }))
    expect(messageRow(t.mirror, FAKE_MARKED.alice, 9)).toMatchObject({ view_once: 1, self_destruct: null })
  })

  test("keeps the earlier version when the same message arrives edited", () => {
    store(fakeMessage({ id: 7, message: "first" }))
    const edited = fakeMessage({ id: 7, message: "second", editDate: FAKE_DATE + 60 })
    expect(store(edited)).toBe("edited")
    expect(messageRow(t.mirror, FAKE_MARKED.alice, 7)).toMatchObject({ body: "second", edited: (FAKE_DATE + 60) * MS })
    expect(rowsOf(t.mirror, "SELECT seq, at, body FROM edits")).toEqual([{ seq: 1, at: FAKE_DATE * MS, body: "first" }])
  })

  test("is not stored when its auto-delete time has passed", () => {
    expect(store(fakeMessage({ ttlPeriod: 60 }))).toBe("expired")
  })

  test("holds no phone number, coordinate, access hash or file reference anywhere in the mirror", () => {
    store(fakeMessage({ id: 1, media: fakePhotoMedia() }))
    const dump = JSON.stringify([
      rowsOf(t.mirror, "SELECT * FROM messages"),
      rowsOf(t.mirror, "SELECT * FROM chats"),
      rowsOf(t.mirror, "SELECT * FROM edits"),
    ])
    expect(dump).toContain("Alice Example")
    for (const value of FAKE_PRIVATE_VALUES) expect(dump).not.toContain(value)
  })
})

describe("a delete made from mtcute objects, applied", () => {
  test("removes a message of a private chat by id alone", () => {
    store(fakeMessage({ id: 7 }))
    const del = deleteInputOf(new DeleteMessageUpdate(fakeDeleteUpdate([7])))
    expect(deleteMessages(t.mirror, t.ctx(), del)).toEqual(["removed"])
    expect(columnOf(t.mirror, "SELECT id FROM messages")).toEqual([])
  })

  test("removes a message of a supergroup by the channel's id", () => {
    const supergroup = fakeSupergroup()
    const chat = chatInputOf(new Chat(supergroup)) as ChatInput
    upsertChats(t.mirror, [chat], NOW)
    setFollowed(t.mirror, chat.id, true)
    const raw = fakeMessage({ id: 7, peerId: channelPeer(), fromId: userPeer() })
    const input = messageInputOf(messageOf(raw, alice, supergroup)) as MessageInput
    expect(storeMessage(t.mirror, t.ctx(), input)).toBe("stored")

    const del = deleteInputOf(new DeleteMessageUpdate(fakeDeleteUpdate([7], FAKE_IDS.supergroup)))
    expect(deleteMessages(t.mirror, t.ctx(), del)).toEqual(["removed"])
    expect(messageRow(t.mirror, FAKE_MARKED.supergroup, 7)).toBeUndefined()
  })

  test("fences out the same message arriving later", () => {
    deleteMessages(t.mirror, t.ctx(), deleteInputOf(new DeleteMessageUpdate(fakeDeleteUpdate([7]))))
    expect(store(fakeMessage({ id: 7 }))).toBe("dropped-deleted")
  })
})
