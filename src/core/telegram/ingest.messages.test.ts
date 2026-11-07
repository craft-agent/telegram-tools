import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { applyRead, upsertChats } from "./ingest-chats"
import { storeMessage } from "./ingest-messages"
import { recordDeleted } from "./mirror-rows"
import type { MessageInput } from "./mirror-input"
import {
  NOW,
  SUPERGROUP,
  USER,
  chatInput,
  chatRow,
  columnOf,
  createTestMirror,
  followChat,
  messageInput,
  messageRow,
  rowsOf,
  type TestMirror,
} from "./mirror.testing"

let t: TestMirror

beforeEach(() => {
  t = createTestMirror()
  followChat(t)
})

afterEach(() => {
  t.close()
})

function store(overrides: Partial<MessageInput> = {}, now = NOW, keep = false) {
  return storeMessage(t.mirror, t.ctx(now, keep), messageInput(overrides))
}

function edits(): unknown[] {
  return rowsOf(t.mirror, "SELECT seq, at, body FROM edits ORDER BY seq")
}

describe("a new message", () => {
  test("is stored with everything it carries", () => {
    const ts = NOW - 60_000
    expect(
      store({
        id: 7,
        topic: 3,
        ts,
        fromMe: true,
        sender: "1000000009",
        senderName: "Me Example",
        body: "see https://example.test",
        entities: [{ type: "text_link", offset: 4, length: 20, url: "https://example.test" }],
        media: { type: "photo", width: 10, height: 20, spoiler: true },
        reply: { id: 5, quote: "earlier" },
        forward: { name: "Someone", date: ts - 1000 },
        grouped: "123456789012345678",
        reactions: [{ emoji: "👍", count: 2, mine: true }],
        viewOnce: true,
        selfDestruct: 10,
      }),
    ).toBe("stored")
    expect(messageRow(t.mirror, USER, 7)).toEqual({
      chat: USER,
      id: 7,
      topic: 3,
      ts,
      from_me: 1,
      sender: "1000000009",
      sender_name: "Me Example",
      kind: "message",
      body: "see https://example.test",
      entities: '[{"type":"text_link","offset":4,"length":20,"url":"https://example.test"}]',
      media: '{"type":"photo","width":10,"height":20,"spoiler":true}',
      action: null,
      reply: '{"id":5,"quote":"earlier"}',
      forward: `{"name":"Someone","date":${ts - 1000}}`,
      grouped: "123456789012345678",
      reactions: '[{"emoji":"👍","count":2,"mine":true}]',
      edited: null,
      expires: null,
      view_once: 1,
      self_destruct: 10,
      kept: 0,
      received: NOW,
    })
  })

  test("stores a service message with its action and no body", () => {
    expect(store({ kind: "service", body: null, action: { type: "chat_rename", title: "New name" } })).toBe("stored")
    expect(messageRow(t.mirror, USER, 1)).toMatchObject({
      kind: "service",
      body: null,
      action: '{"type":"chat_rename","title":"New name"}',
    })
  })

  test("keeps the same id in two chats apart", () => {
    followChat(t, { id: SUPERGROUP, kind: "supergroup", username: null })
    store({ id: 5, body: "private" })
    store({ id: 5, chat: SUPERGROUP, body: "super" })
    expect(columnOf(t.mirror, "SELECT body FROM messages ORDER BY chat DESC")).toEqual(["private", "super"])
  })

  test("moves the chat's top_id and last_ts forward, and never back", () => {
    store({ id: 10, ts: NOW - 1000 })
    expect(chatRow(t.mirror, USER)).toMatchObject({ top_id: 10, last_ts: NOW - 1000 })
    store({ id: 4, ts: NOW - 5000 })
    expect(chatRow(t.mirror, USER)).toMatchObject({ top_id: 10, last_ts: NOW - 1000 })
    store({ id: 11, ts: NOW - 500 })
    expect(chatRow(t.mirror, USER)).toMatchObject({ top_id: 11, last_ts: NOW - 500 })
  })

  test("is skipped when it lacks a chat, a positive id, a time or a kind", () => {
    const outcomes = [
      store({ chat: "" }),
      store({ id: 0 }),
      store({ id: 1.5 }),
      store({ ts: Number.NaN }),
      store({ kind: "other" as MessageInput["kind"] }),
    ]
    expect(outcomes).toEqual(["skipped", "skipped", "skipped", "skipped", "skipped"])
    expect(columnOf(t.mirror, "SELECT id FROM messages")).toEqual([])
  })

  test("skips malformed fields without preventing the rest of a batch from being stored", () => {
    const malformed: Record<string, unknown>[] = [
      { fromMe: 1 },
      { viewOnce: "false" },
      ...["sender", "senderName", "body", "grouped"].map((field) => ({ [field]: {} })),
      ...["topic", "ts", "edited", "ttl", "selfDestruct"].flatMap((field) =>
        [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"].map((value) => ({ [field]: value })),
      ),
      { topic: 0 },
      { entities: null },
      { entities: [{}] },
      { entities: [null] },
      { entities: [{ type: 1, offset: 0, length: 1 }] },
      { entities: [{ type: "bold", offset: -1, length: 1 }] },
      { entities: [{ type: "bold", offset: 0, length: 1.5 }] },
      ...["url", "user"].map((field) => ({ entities: [{ type: "link", offset: 0, length: 1, [field]: 1 }] })),
      ...["media", "action", "reply", "forward"].flatMap((field) =>
        [[], "bad", 1].map((value) => ({ [field]: value })),
      ),
      { media: {} },
      { media: { type: 1 } },
      { media: { type: "photo", spoiler: false } },
      ...["name", "mime", "emoji", "title", "url", "question", "what"].map((field) => ({
        media: { type: "file", [field]: 1 },
      })),
      ...["size", "duration", "width", "height"].map((field) => ({ media: { type: "file", [field]: -1 } })),
      { action: {} },
      { action: { type: "rename", title: 1 } },
      { action: { type: "ttl", period: -1 } },
      { action: { type: "add", users: [1] } },
      { reply: { id: 0 } },
      { reply: { topic: -1 } },
      { reply: { chat: 1 } },
      { reply: { quote: 1 } },
      { forward: { from: 1 } },
      { forward: { name: 1 } },
      { forward: { date: -1 } },
      { forward: { id: 0 } },
      { reactions: {} },
      { reactions: [null] },
      { reactions: [{}] },
      { reactions: [{ emoji: 1, count: 1 }] },
      { reactions: [{ emoji: "👍", count: -1 }] },
      { reactions: [{ emoji: "👍", count: 1, mine: false }] },
    ]
    const batch = [
      messageInput({ id: 2 }),
      ...malformed.map((fields) => ({ ...messageInput(), ...fields })),
      messageInput({ id: 3 }),
    ]
    const outcomes = batch.map((msg) => storeMessage(t.mirror, t.ctx(), msg as MessageInput))
    expect(outcomes).toEqual(["stored", ...malformed.map(() => "skipped" as const), "stored"])
    expect(columnOf(t.mirror, "SELECT id FROM messages ORDER BY id")).toEqual([2, 3])
  })

  test("does not swallow real SQLite failures", () => {
    t.mirror.exec("PRAGMA query_only = ON")
    expect(() => store()).toThrow()
  })
})

describe("a message seen again", () => {
  test("changes nothing, not even when received later", () => {
    store({ body: "first" })
    expect(store({ body: "first, again" }, NOW + 5000)).toBe("unchanged")
    expect(messageRow(t.mirror, USER, 1)).toMatchObject({ body: "first", received: NOW, edited: null })
    expect(edits()).toEqual([])
  })

  test("takes only the reactions when it gives them", () => {
    store({ reactions: [{ emoji: "👍", count: 1 }] })
    expect(store({ body: "ignored", reactions: null })).toBe("unchanged")
    expect(messageRow(t.mirror, USER, 1)?.reactions).toBe('[{"emoji":"👍","count":1}]')
    expect(store({ body: "ignored", reactions: [{ emoji: "🎉", count: 3 }] })).toBe("unchanged")
    expect(messageRow(t.mirror, USER, 1)).toMatchObject({ body: "hello", reactions: '[{"emoji":"🎉","count":3}]' })
    store({ reactions: [] })
    expect(messageRow(t.mirror, USER, 1)?.reactions).toBeNull()
  })
})

describe("an edit", () => {
  const original = NOW - 60_000

  test("keeps the earlier version and shows the new one", () => {
    store({ ts: original, body: "v1", entities: [{ type: "bold", offset: 0, length: 2 }] })
    expect(store({ ts: original, body: "v2", edited: original + 1000 })).toBe("edited")
    expect(messageRow(t.mirror, USER, 1)).toMatchObject({ body: "v2", entities: null, edited: original + 1000 })
    expect(edits()).toEqual([{ seq: 1, at: original, body: "v1" }])
    expect(rowsOf(t.mirror, "SELECT entities, media FROM edits")).toEqual([
      { entities: '[{"type":"bold","offset":0,"length":2}]', media: null },
    ])
  })

  test("keeps every version over several edits, newest shown", () => {
    store({ ts: original, body: "v1" })
    store({ ts: original, body: "v2", edited: original + 1000 })
    store({ ts: original, body: "v3", edited: original + 2000 })
    expect(messageRow(t.mirror, USER, 1)).toMatchObject({ body: "v3", edited: original + 2000 })
    expect(edits()).toEqual([
      { seq: 1, at: original, body: "v1" },
      { seq: 2, at: original + 1000, body: "v2" },
    ])
  })

  test("changes nothing when it is older than the shown version or the same", () => {
    store({ ts: original, body: "v1" })
    store({ ts: original, body: "v3", edited: original + 2000 })
    expect(store({ ts: original, body: "v2", edited: original + 1000 })).toBe("unchanged")
    expect(store({ ts: original, body: "v3 again", edited: original + 2000 })).toBe("unchanged")
    expect(messageRow(t.mirror, USER, 1)).toMatchObject({ body: "v3", edited: original + 2000 })
    expect(edits()).toEqual([{ seq: 1, at: original, body: "v1" }])
  })

  test("keeps versions with equal times under distinct sequence numbers", () => {
    store({ ts: original, body: "v1" })
    expect(store({ ts: original, body: "v2", edited: original })).toBe("edited")
    expect(store({ ts: original, body: "v3", edited: original + 1000 })).toBe("edited")
    expect(edits()).toEqual([
      { seq: 1, at: original, body: "v1" },
      { seq: 2, at: original, body: "v2" },
    ])
    expect(messageRow(t.mirror, USER, 1)).toMatchObject({ body: "v3", edited: original + 1000 })
  })

  test("of a message the mirror never saw is stored as the message, without history", () => {
    expect(store({ ts: original, body: "v2", edited: original + 1000 })).toBe("stored")
    expect(messageRow(t.mirror, USER, 1)).toMatchObject({ body: "v2", edited: original + 1000 })
    expect(edits()).toEqual([])
  })

  test("takes the reactions it gives along with the new version", () => {
    store({ ts: original, reactions: [{ emoji: "👍", count: 1 }] })
    store({ ts: original, body: "v2", edited: original + 1000, reactions: null })
    expect(messageRow(t.mirror, USER, 1)?.reactions).toBe('[{"emoji":"👍","count":1}]')
    store({ ts: original, body: "v3", edited: original + 2000, reactions: [{ emoji: "🎉", count: 1 }] })
    expect(messageRow(t.mirror, USER, 1)?.reactions).toBe('[{"emoji":"🎉","count":1}]')
  })
})

describe("a message that is not kept", () => {
  test("from a chat the mirror does not know is dropped", () => {
    expect(store({ chat: "1000000077" })).toBe("dropped-unfollowed")
    expect(columnOf(t.mirror, "SELECT id FROM messages")).toEqual([])
  })

  test("from a chat that is not followed is dropped", () => {
    upsertChats(t.mirror, [chatInput({ id: SUPERGROUP, kind: "supergroup", username: null })], NOW)
    expect(store({ chat: SUPERGROUP })).toBe("dropped-unfollowed")
    expect(columnOf(t.mirror, "SELECT id FROM messages")).toEqual([])
    expect(chatRow(t.mirror, SUPERGROUP)).toMatchObject({ top_id: null, last_ts: null })
  })

  test("with a tombstone is dropped, for its chat or, in a private chat, for none", () => {
    recordDeleted(t.mirror, USER, 1, NOW)
    recordDeleted(t.mirror, null, 2, NOW)
    expect([store({ id: 1 }), store({ id: 2 }), store({ id: 3 })]).toEqual([
      "dropped-deleted",
      "dropped-deleted",
      "stored",
    ])
    expect(columnOf(t.mirror, "SELECT id FROM messages")).toEqual([3])
  })

  test("with a tombstone of another chat or, in a supergroup, of none is stored", () => {
    followChat(t, { id: SUPERGROUP, kind: "supergroup", username: null })
    recordDeleted(t.mirror, null, 2, NOW)
    recordDeleted(t.mirror, "1000000077", 3, NOW)
    expect(store({ chat: SUPERGROUP, id: 2 })).toBe("stored")
    expect(store({ chat: SUPERGROUP, id: 3 })).toBe("stored")
  })

  test("with a tombstone drops its edit too", () => {
    store({ ts: NOW - 60_000 })
    recordDeleted(t.mirror, USER, 1, NOW)
    expect(store({ body: "v2", edited: NOW - 30_000 })).toBe("dropped-deleted")
    expect(messageRow(t.mirror, USER, 1)?.body).toBe("hello")
  })
})

describe("a disappearing message", () => {
  const ts = NOW - 120_000

  test("not yet due is stored with the time it goes", () => {
    expect(store({ ts, ttl: 600 })).toBe("stored")
    expect(messageRow(t.mirror, USER, 1)).toMatchObject({ expires: ts + 600_000, kept: 0 })
  })

  test("already gone on arrival is not stored with keep off", () => {
    expect(store({ ts, ttl: 60 })).toBe("expired")
    expect(store({ ts, ttl: 120 })).toBe("expired")
    expect(columnOf(t.mirror, "SELECT id FROM messages")).toEqual([])
    expect(chatRow(t.mirror, USER)).toMatchObject({ top_id: null, last_ts: null })
  })

  test("already gone on arrival is stored as kept with keep on", () => {
    expect(store({ ts, ttl: 60 }, NOW, true)).toBe("stored")
    expect(messageRow(t.mirror, USER, 1)).toMatchObject({ expires: ts + 60_000, kept: 1 })
  })

  test("not yet due is not marked kept with keep on", () => {
    store({ ts, ttl: 600 }, NOW, true)
    expect(messageRow(t.mirror, USER, 1)?.kept).toBe(0)
  })

  test("a timer of zero is no timer and a negative timer is skipped", () => {
    expect(store({ id: 1, ts, ttl: 0 })).toBe("stored")
    expect(store({ id: 2, ts, ttl: -5 })).toBe("skipped")
    expect(columnOf(t.mirror, "SELECT expires FROM messages ORDER BY id")).toEqual([null])
  })

  test.each([null, NOW + 10])("seen again or edited at %s removes an expired row with keep off", (edited) => {
    store({ ts, ttl: 60 }, ts, true)
    store({ ts, ttl: 60, body: "v2", edited: ts + 1000 }, ts + 1000, true)
    store({ ts, ttl: 60 }, NOW, true)
    expect(edits()).toHaveLength(1)
    expect(store({ ts, ttl: 6000, body: "again", edited }, NOW + 10, false)).toBe("expired")
    expect(messageRow(t.mirror, USER, 1)).toBeUndefined()
    expect(edits()).toEqual([])
    expect(rowsOf(t.mirror, "SELECT * FROM deleted")).toEqual([])
  })

  test.each([null, NOW + 10])("seen again or edited at %s marks an expired row kept with keep on", (edited) => {
    store({ ts, ttl: 60 }, ts)
    expect(store({ ts, ttl: 6000, body: "again", edited }, NOW + 10, true)).toBe(
      edited === null ? "unchanged" : "edited",
    )
    expect(messageRow(t.mirror, USER, 1)).toMatchObject({
      expires: ts + 60_000,
      kept: 1,
      body: edited === null ? "hello" : "again",
    })
  })
})

describe("the unread count", () => {
  function unread(): unknown {
    return chatRow(t.mirror, USER)?.unread
  }

  test("grows by one for each new incoming message, service messages included", () => {
    store({ id: 1 })
    store({ id: 2, kind: "service", body: null, action: { type: "pin" } })
    store({ id: 3 })
    expect(unread()).toBe(3)
  })

  test("does not grow for the account's own message", () => {
    store({ id: 1, fromMe: true })
    expect(unread()).toBe(0)
  })

  test("does not grow for a repeat or an edit", () => {
    store({ id: 1 })
    store({ id: 1, body: "again" })
    store({ id: 1, body: "v2", edited: NOW - 1000 })
    expect(unread()).toBe(1)
  })

  test("does not grow for a message dropped on arrival", () => {
    store({ ts: NOW - 120_000, ttl: 60 })
    store({ chat: "1000000077" })
    expect(unread()).toBe(0)
  })

  test("does not grow for an id at or below read_max, and does for one above it", () => {
    upsertChats(t.mirror, [chatInput({ readMax: 5 })], NOW)
    store({ id: 4 })
    store({ id: 5 })
    expect(unread()).toBe(0)
    store({ id: 6 })
    expect(unread()).toBe(1)
  })

  test("is set outright by applyRead afterwards, and grows again from there", () => {
    store({ id: 1 })
    store({ id: 2 })
    applyRead(t.mirror, { chat: USER, maxId: 2, unread: 0 })
    expect(unread()).toBe(0)
    store({ id: 2 })
    expect(unread()).toBe(0)
    store({ id: 3 })
    expect(unread()).toBe(1)
  })

  test("is set outright by the chat input", () => {
    store({ id: 1 })
    upsertChats(t.mirror, [chatInput({ unread: 9 })], NOW)
    expect(unread()).toBe(9)
    store({ id: 2 })
    expect(unread()).toBe(10)
  })
})
