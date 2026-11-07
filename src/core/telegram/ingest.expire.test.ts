import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  DELETE_GRACE_MS,
  GAP_SETTLE_MS,
  GAP_TTL_MS,
  TOMBSTONE_TTL_MS,
  deleteMessages,
  expireMessages,
  purge,
  recordGap,
} from "./ingest-delete"
import { storeMessage } from "./ingest-messages"
import { recordDeleted } from "./mirror-rows"
import type { MessageInput } from "./mirror-input"
import {
  NOW,
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
})

afterEach(() => {
  t.close()
})

/** Stores a message that arrived ten minutes before `NOW` and disappears after `ttl` seconds. */
function putTimed(id: number, ttl: number | null, overrides: Partial<MessageInput> = {}): void {
  const ts = NOW - 10 * MINUTE
  storeMessage(t.mirror, t.ctx(ts), messageInput({ id, ts, ttl, ...overrides }))
}

describe("the constants", () => {
  test("are the periods the design names", () => {
    expect(DELETE_GRACE_MS).toBe(5 * MINUTE)
    expect(GAP_SETTLE_MS).toBe(10 * MINUTE)
    expect(TOMBSTONE_TTL_MS).toBe(2 * 24 * 60 * MINUTE)
    expect(GAP_TTL_MS).toBe(30 * 24 * 60 * MINUTE)
  })
})

describe("expireMessages", () => {
  test("with keep off deletes the messages whose time has come, with their versions, and nothing else", () => {
    putTimed(1, 600)
    putTimed(2, 600, { edited: NOW - MINUTE })
    putTimed(3, 3600)
    putTimed(4, null)
    putTimed(2, 600, { body: "v2", edited: NOW - 30_000 })
    expect(columnOf(t.mirror, "SELECT id FROM edits")).toEqual([2])
    expect(expireMessages(t.mirror, t.ctx(NOW))).toBe(2)
    expect(columnOf(t.mirror, "SELECT id FROM messages ORDER BY id")).toEqual([3, 4])
    expect(columnOf(t.mirror, "SELECT id FROM edits")).toEqual([])
    expect(columnOf(t.mirror, "SELECT id FROM deleted")).toEqual([])
  })

  test("with keep off deletes a message that was marked kept", () => {
    putTimed(1, 600)
    deleteMessages(t.mirror, t.ctx(NOW, true), deleteInput())
    expect(messageRow(t.mirror, USER, 1)?.kept).toBe(1)
    expect(expireMessages(t.mirror, t.ctx(NOW + 1))).toBe(1)
    expect(columnOf(t.mirror, "SELECT id FROM messages")).toEqual([])
  })

  test("with keep on marks them kept and leaves them, once", () => {
    putTimed(1, 600)
    putTimed(2, 3600)
    expect(expireMessages(t.mirror, t.ctx(NOW, true))).toBe(1)
    expect(rowsOf(t.mirror, "SELECT id, kept FROM messages ORDER BY id")).toEqual([
      { id: 1, kept: 1 },
      { id: 2, kept: 0 },
    ])
    expect(expireMessages(t.mirror, t.ctx(NOW, true))).toBe(0)
  })

  test("does nothing before any time has come", () => {
    putTimed(1, 3600)
    expect(expireMessages(t.mirror, t.ctx(NOW))).toBe(0)
    expect(expireMessages(t.mirror, t.ctx(NOW, true))).toBe(0)
    expect(columnOf(t.mirror, "SELECT id FROM messages")).toEqual([1])
  })
})

describe("recordGap", () => {
  test("records a span, and ignores one that is empty, reversed or not a time", () => {
    recordGap(t.mirror, 1000, 2000)
    recordGap(t.mirror, 3000, 3000)
    recordGap(t.mirror, 5000, 4000)
    recordGap(t.mirror, -1, 10)
    recordGap(t.mirror, Number.NaN, 10)
    expect(rowsOf(t.mirror, "SELECT start, until FROM gaps")).toEqual([{ start: 1000, until: 2000 }])
  })

  test("is what keeps a delete from being taken for a timer", () => {
    putTimed(1, 600)
    recordGap(t.mirror, NOW - 20 * MINUTE, NOW - 4 * MINUTE)
    expect(deleteMessages(t.mirror, t.ctx(NOW, true), deleteInput())).toEqual(["removed"])
  })
})

describe("purge", () => {
  test("forgets tombstones past their period and keeps newer ones", () => {
    recordDeleted(t.mirror, USER, 1, NOW - TOMBSTONE_TTL_MS)
    recordDeleted(t.mirror, USER, 2, NOW - TOMBSTONE_TTL_MS + 1)
    recordDeleted(t.mirror, null, 3, NOW)
    purge(t.mirror, NOW)
    expect(columnOf(t.mirror, "SELECT id FROM deleted ORDER BY id")).toEqual([2, 3])
  })

  test("forgets gaps past their period and keeps newer ones", () => {
    recordGap(t.mirror, 1, NOW - GAP_TTL_MS)
    recordGap(t.mirror, 1, NOW - GAP_TTL_MS + 1)
    purge(t.mirror, NOW)
    expect(columnOf(t.mirror, "SELECT until FROM gaps")).toEqual([NOW - GAP_TTL_MS + 1])
  })

  test("never removes messages, kept ones included", () => {
    putTimed(1, 600)
    deleteMessages(t.mirror, t.ctx(NOW, true), deleteInput())
    purge(t.mirror, NOW + GAP_TTL_MS * 2)
    expect(columnOf(t.mirror, "SELECT id FROM messages")).toEqual([1])
  })
})
