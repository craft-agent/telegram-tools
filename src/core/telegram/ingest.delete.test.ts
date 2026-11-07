import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { deleteMessages } from "./ingest-delete"
import { storeMessage } from "./ingest-messages"
import type { DeleteInput, MessageInput } from "./mirror-input"
import {
  CHANNEL,
  GROUP,
  NOW,
  SUPERGROUP,
  USER,
  columnOf,
  createTestMirror,
  deleteInput,
  followChat,
  messageInput,
  messageRow,
  rowsOf,
  type TestMirror,
} from "./mirror.testing"

let t: TestMirror

const MINUTE = 60_000

beforeEach(() => {
  t = createTestMirror()
  followChat(t)
  followChat(t, { id: GROUP, kind: "group", username: null })
  followChat(t, { id: SUPERGROUP, kind: "supergroup", username: null })
  followChat(t, { id: CHANNEL, kind: "channel", username: null })
})

afterEach(() => {
  t.close()
})

function put(overrides: Partial<MessageInput> = {}, now = NOW - 10 * MINUTE): void {
  storeMessage(t.mirror, t.ctx(now), messageInput(overrides))
}

/** Stores a message that disappears at `NOW`, arriving ten minutes before. */
function putTimed(overrides: Partial<MessageInput> = {}): void {
  put({ ts: NOW - 10 * MINUTE, ttl: 600, ...overrides })
}

function remove(input: Partial<DeleteInput> = {}, at = NOW, keep = false) {
  return deleteMessages(t.mirror, t.ctx(at, keep), deleteInput(input))
}

function tombstones(): unknown[] {
  return rowsOf(t.mirror, "SELECT chat, id, at FROM deleted ORDER BY chat, id")
}

describe("a delete that names the chat", () => {
  test("removes the message and its earlier versions, and leaves a tombstone", () => {
    put({ body: "v1" })
    put({ body: "v2", edited: NOW - MINUTE })
    put({ id: 2, body: "other" })
    expect(remove({ ids: [1] }, NOW + 5)).toEqual(["removed"])
    expect(columnOf(t.mirror, "SELECT id FROM messages")).toEqual([2])
    expect(columnOf(t.mirror, "SELECT id FROM edits")).toEqual([])
    expect(tombstones()).toEqual([{ chat: USER, id: 1, at: NOW + 5 }])
  })

  test("touches only that chat's message of the id", () => {
    put({ id: 5 })
    put({ id: 5, chat: SUPERGROUP })
    remove({ chat: SUPERGROUP, ids: [5] })
    expect(columnOf(t.mirror, "SELECT chat FROM messages")).toEqual([USER])
  })

  test("with no message only records the tombstone, and the message that follows is dropped", () => {
    expect(remove({ ids: [1] })).toEqual(["tombstoned"])
    expect(tombstones()).toEqual([{ chat: USER, id: 1, at: NOW }])
    expect(storeMessage(t.mirror, t.ctx(), messageInput())).toBe("dropped-deleted")
  })

  test("repeated moves the tombstone's time forward and keeps one", () => {
    remove({ ids: [1] }, NOW)
    remove({ ids: [1] }, NOW + 1000)
    expect(tombstones()).toEqual([{ chat: USER, id: 1, at: NOW + 1000 }])
  })

  test("gives an outcome for each valid id and skips the others", () => {
    put({ id: 2 })
    expect(remove({ ids: [0, 1.5, -3, 2, 3, Number.NaN] })).toEqual(["removed", "tombstoned"])
    expect(tombstones()).toEqual([
      { chat: USER, id: 2, at: NOW },
      { chat: USER, id: 3, at: NOW },
    ])
  })

  test("skips a chat that is not an id", () => {
    put()
    expect(remove({ chat: "" })).toEqual([])
    expect(columnOf(t.mirror, "SELECT id FROM messages")).toEqual([1])
    expect(tombstones()).toEqual([])
  })
})

describe("a delete that names no chat", () => {
  test("removes the message in private chats and basic groups, not in supergroups or channels", () => {
    put({ id: 5 })
    put({ id: 6, chat: GROUP })
    put({ id: 5, chat: SUPERGROUP })
    put({ id: 5, chat: CHANNEL })
    expect(remove({ chat: null, ids: [5, 6] })).toEqual(["removed", "removed"])
    expect(rowsOf(t.mirror, "SELECT chat, id FROM messages ORDER BY chat")).toEqual([
      { chat: SUPERGROUP, id: 5 },
      { chat: CHANNEL, id: 5 },
    ])
    expect(tombstones()).toEqual([
      { chat: null, id: 5, at: NOW },
      { chat: null, id: 6, at: NOW },
    ])
  })

  test("leaves a tombstone that drops the message in a private chat or basic group but not a supergroup", () => {
    expect(remove({ chat: null, ids: [5] })).toEqual(["tombstoned"])
    const store = (chat: string) => storeMessage(t.mirror, t.ctx(), messageInput({ chat, id: 5 }))
    expect([store(USER), store(GROUP), store(SUPERGROUP), store(CHANNEL)]).toEqual([
      "dropped-deleted",
      "dropped-deleted",
      "stored",
      "stored",
    ])
  })

  test("repeated keeps one tombstone", () => {
    remove({ chat: null, ids: [5] }, NOW)
    remove({ chat: null, ids: [5] }, NOW + 1)
    expect(tombstones()).toEqual([{ chat: null, id: 5, at: NOW + 1 }])
  })
})

describe("a delete of a message on a timer, with keep_disappearing on", () => {
  /** Where the message's timer runs out. */
  const expires = NOW

  function removeAt(at: number, input: Partial<DeleteInput> = {}) {
    return remove(input, at, true)
  }

  test("at its time keeps the message, marked, with its versions and no tombstone", () => {
    putTimed({ body: "v1" })
    putTimed({ body: "v2", edited: NOW - 5 * MINUTE })
    expect(removeAt(expires)).toEqual(["kept"])
    expect(messageRow(t.mirror, USER, 1)).toMatchObject({ body: "v2", kept: 1, expires })
    expect(columnOf(t.mirror, "SELECT id FROM edits")).toEqual([1])
    expect(tombstones()).toEqual([])
  })

  test("within five minutes before its time keeps it and moves its time up to now", () => {
    putTimed()
    expect(removeAt(expires - 5 * MINUTE)).toEqual(["kept"])
    expect(messageRow(t.mirror, USER, 1)).toMatchObject({ kept: 1, expires: expires - 5 * MINUTE })
  })

  test("within five minutes after its time keeps it and leaves its time", () => {
    putTimed()
    expect(removeAt(expires + 5 * MINUTE)).toEqual(["kept"])
    expect(messageRow(t.mirror, USER, 1)).toMatchObject({ kept: 1, expires })
  })

  test("more than five minutes before or after its time removes it with a tombstone", () => {
    putTimed({ id: 1 })
    putTimed({ id: 2 })
    expect(removeAt(expires - 5 * MINUTE - 1, { ids: [1] })).toEqual(["removed"])
    expect(removeAt(expires + 5 * MINUTE + 1, { ids: [2] })).toEqual(["removed"])
    expect(columnOf(t.mirror, "SELECT id FROM messages")).toEqual([])
    expect(tombstones()).toHaveLength(2)
  })

  test("without a timer removes it with a tombstone", () => {
    put()
    expect(removeAt(NOW)).toEqual(["removed"])
    expect(tombstones()).toEqual([{ chat: USER, id: 1, at: NOW }])
  })

  test("of view-once media without a timer removes it", () => {
    put({ viewOnce: true, media: { type: "photo" } })
    expect(removeAt(NOW)).toEqual(["removed"])
    expect(tombstones()).toHaveLength(1)
  })

  test("of view-once media that also has the chat's timer is decided by the timer", () => {
    putTimed({ viewOnce: true, media: { type: "photo" } })
    expect(removeAt(expires)).toEqual(["kept"])
    expect(messageRow(t.mirror, USER, 1)).toMatchObject({ view_once: 1, kept: 1 })
  })

  test("for a message in a supergroup, named by its chat, is decided the same way", () => {
    putTimed({ chat: SUPERGROUP })
    expect(removeAt(expires, { chat: SUPERGROUP })).toEqual(["kept"])
  })

  test("with no chat named is decided the same way in a private chat", () => {
    putTimed()
    expect(removeAt(expires, { chat: null })).toEqual(["kept"])
    expect(tombstones()).toEqual([])
  })

  test("is removed when its time fell inside a gap in watching", () => {
    const edge = expires - 5 * MINUTE
    putTimed()
    t.mirror.prepare("INSERT INTO gaps (start, until) VALUES (?, ?)").run(edge - 1000, edge + 1000)
    expect(removeAt(expires)).toEqual(["removed"])
  })

  test("is removed when its time fell inside the settle time after a gap, and kept just after it", () => {
    const edge = expires - 5 * MINUTE
    const gap = (until: number) =>
      t.mirror.prepare("INSERT INTO gaps (start, until) VALUES (?, ?)").run(edge - 20 * MINUTE, until)
    putTimed({ id: 1 })
    putTimed({ id: 2 })
    gap(edge - 10 * MINUTE + 1)
    expect(removeAt(expires, { ids: [1] })).toEqual(["removed"])
    t.mirror.exec("DELETE FROM gaps")
    gap(edge - 10 * MINUTE)
    expect(removeAt(expires, { ids: [2] })).toEqual(["kept"])
  })

  test("is kept when a gap began at the edge or ended long before it", () => {
    const edge = expires - 5 * MINUTE
    putTimed()
    t.mirror.prepare("INSERT INTO gaps (start, until) VALUES (?, ?)").run(edge, edge + 3 * MINUTE)
    t.mirror.prepare("INSERT INTO gaps (start, until) VALUES (?, ?)").run(edge - 60 * MINUTE, edge - 30 * MINUTE)
    expect(removeAt(expires)).toEqual(["kept"])
  })
})

describe("a delete of a message on a timer, with keep_disappearing off", () => {
  test("at its time removes it with a tombstone", () => {
    putTimed()
    expect(remove({}, NOW, false)).toEqual(["removed"])
    expect(columnOf(t.mirror, "SELECT id FROM messages")).toEqual([])
    expect(tombstones()).toEqual([{ chat: USER, id: 1, at: NOW }])
  })
})
