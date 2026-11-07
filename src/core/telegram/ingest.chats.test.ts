import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { applyRead, setFollowed, upsertChats, upsertTopics } from "./ingest-chats"
import type { ChatInput, ReadInput, TopicInput } from "./mirror-input"
import {
  GROUP,
  NOW,
  OTHER_USER,
  SUPERGROUP,
  USER,
  chatInput,
  chatRow,
  columnOf,
  createTestMirror,
  rowsOf,
  type TestMirror,
} from "./mirror.testing"

let t: TestMirror

beforeEach(() => {
  t = createTestMirror()
})

afterEach(() => {
  t.close()
})

describe("upsertChats", () => {
  test("skips malformed fields and continues the batch", () => {
    const malformed = [
      ...["name", "username"].map((field) => ({ [field]: {} })),
      ...["forum", "left", "archived", "canSend"].map((field) => ({ [field]: 1 })),
      ...["unread", "readMax", "topId", "lastTs", "ttl"].flatMap((field) =>
        [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1"].map((value) => ({ [field]: value })),
      ),
      { unread: null },
      { topId: 0 },
      { readMax: 0 },
    ].map((fields) => ({ ...chatInput(), ...fields })) as unknown as ChatInput[]
    upsertChats(t.mirror, [chatInput({ id: GROUP, kind: "group" }), ...malformed, chatInput({ id: OTHER_USER })], NOW)
    expect(columnOf(t.mirror, "SELECT id FROM chats ORDER BY id")).toEqual([GROUP, OTHER_USER])
  })

  test("inserts a chat with the defaults of what the input leaves out", () => {
    upsertChats(t.mirror, [chatInput()], NOW)
    expect(chatRow(t.mirror, USER)).toEqual({
      id: USER,
      kind: "user",
      name: "Alice Example",
      username: "alice_example",
      forum: 0,
      left: 0,
      can_send: null,
      archived: 0,
      followed: 0,
      unread: 0,
      read_max: null,
      top_id: null,
      last_ts: null,
      ttl: null,
      updated: NOW,
    })
  })

  test("takes every field the input gives, and leaves absent ones as stored", () => {
    upsertChats(t.mirror, [chatInput({ forum: true, archived: true, canSend: true, unread: 3, ttl: 86400 })], NOW)
    upsertChats(t.mirror, [chatInput({ name: "Alice Renamed", username: null, left: true })], NOW + 1)
    expect(chatRow(t.mirror, USER)).toMatchObject({
      name: "Alice Renamed",
      username: null,
      forum: 1,
      archived: 1,
      left: 1,
      can_send: 1,
      unread: 3,
      ttl: 86400,
      updated: NOW + 1,
    })
  })

  test("sets an unknown value back to unknown with null, and keeps a name the input lacks", () => {
    upsertChats(t.mirror, [chatInput({ canSend: true, ttl: 60 })], NOW)
    upsertChats(t.mirror, [chatInput({ name: null, canSend: null, ttl: null })], NOW)
    expect(chatRow(t.mirror, USER)).toMatchObject({ name: "Alice Example", can_send: null, ttl: null })
  })

  test("only grows top_id, last_ts and read_max", () => {
    upsertChats(t.mirror, [chatInput({ topId: 10, lastTs: NOW, readMax: 8 })], NOW)
    upsertChats(t.mirror, [chatInput({ topId: 4, lastTs: NOW - 1000, readMax: 2 })], NOW)
    expect(chatRow(t.mirror, USER)).toMatchObject({ top_id: 10, last_ts: NOW, read_max: 8 })
    upsertChats(t.mirror, [chatInput({ topId: 12, lastTs: NOW + 5, readMax: null })], NOW)
    expect(chatRow(t.mirror, USER)).toMatchObject({ top_id: 12, last_ts: NOW + 5, read_max: 8 })
  })

  test("never touches followed", () => {
    upsertChats(t.mirror, [chatInput()], NOW)
    setFollowed(t.mirror, USER, true)
    upsertChats(t.mirror, [chatInput({ name: "Alice Again" })], NOW)
    expect(chatRow(t.mirror, USER)).toMatchObject({ followed: 1, name: "Alice Again" })
  })

  test("writes several chats and skips input that is not a chat", () => {
    const broken = [
      { ...chatInput({ id: "" }) },
      { ...chatInput({ id: "5" }), kind: "unknown" },
    ] as unknown as ChatInput[]
    upsertChats(
      t.mirror,
      [chatInput(), ...broken, chatInput({ id: GROUP, kind: "group", name: "Group", username: null })],
      NOW,
    )
    expect(columnOf(t.mirror, "SELECT id FROM chats ORDER BY id")).toEqual([GROUP, USER])
  })
})

describe("applyRead", () => {
  test("skips a malformed record without partially updating the chat", () => {
    upsertChats(t.mirror, [chatInput({ unread: 5, readMax: 3 })], NOW)
    const malformed = [
      { chat: 1 },
      { maxId: 0 },
      { maxId: 1.5 },
      { maxId: Number.MAX_SAFE_INTEGER + 1 },
      ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1", undefined].map((unread) => ({ unread })),
    ]
    for (const fields of malformed) {
      applyRead(t.mirror, { chat: USER, maxId: 9, unread: 0, ...fields } as ReadInput)
      expect(chatRow(t.mirror, USER)).toMatchObject({ read_max: 3, unread: 5 })
    }
    applyRead(t.mirror, { chat: USER, maxId: 7, unread: 1 })
    expect(chatRow(t.mirror, USER)).toMatchObject({ read_max: 7, unread: 1 })
  })

  test("grows read_max and sets unread when given", () => {
    upsertChats(t.mirror, [chatInput({ unread: 5, readMax: 3 })], NOW)
    applyRead(t.mirror, { chat: USER, maxId: 7, unread: 1 })
    expect(chatRow(t.mirror, USER)).toMatchObject({ read_max: 7, unread: 1 })
    applyRead(t.mirror, { chat: USER, maxId: 4, unread: null })
    expect(chatRow(t.mirror, USER)).toMatchObject({ read_max: 7, unread: 1 })
  })

  test("sets read_max of a chat that had none, and ignores a chat the mirror lacks or a bad id", () => {
    upsertChats(t.mirror, [chatInput()], NOW)
    applyRead(t.mirror, { chat: USER, maxId: 2, unread: null })
    applyRead(t.mirror, { chat: OTHER_USER, maxId: 9, unread: 0 })
    applyRead(t.mirror, { chat: USER, maxId: -1, unread: 0 })
    expect(chatRow(t.mirror, USER)).toMatchObject({ read_max: 2, unread: 0 })
    expect(chatRow(t.mirror, OTHER_USER)).toBeUndefined()
  })
})

describe("upsertTopics", () => {
  test("skips malformed fields and continues the batch", () => {
    const malformed = [
      { chat: 1 },
      { id: 0 },
      { id: -1 },
      { id: 0.5 },
      { id: Number.MAX_SAFE_INTEGER + 1 },
      { title: {} },
      { closed: 1 },
      { closed: null },
    ].map((fields) => ({ chat: SUPERGROUP, id: 2, ...fields })) as unknown as TopicInput[]
    upsertTopics(t.mirror, [{ chat: SUPERGROUP, id: 1 }, ...malformed, { chat: SUPERGROUP, id: 3 }], NOW)
    expect(columnOf(t.mirror, "SELECT id FROM topics ORDER BY id")).toEqual([1, 3])
  })

  test("closing a topic keeps its title", () => {
    upsertTopics(t.mirror, [{ chat: SUPERGROUP, id: 2, title: "General talk", closed: false }], NOW)
    upsertTopics(t.mirror, [{ chat: SUPERGROUP, id: 2, closed: true }], NOW + 1)
    expect(rowsOf(t.mirror, "SELECT * FROM topics")).toEqual([
      { chat: SUPERGROUP, id: 2, title: "General talk", closed: 1, updated: NOW + 1 },
    ])
  })

  test("renaming a topic keeps it closed", () => {
    upsertTopics(t.mirror, [{ chat: SUPERGROUP, id: 2, title: "Before", closed: true }], NOW)
    upsertTopics(t.mirror, [{ chat: SUPERGROUP, id: 2, title: "After" }], NOW + 1)
    expect(rowsOf(t.mirror, "SELECT * FROM topics")).toEqual([
      { chat: SUPERGROUP, id: 2, title: "After", closed: 1, updated: NOW + 1 },
    ])
  })

  test("new topics default to no title and open, and an explicit null clears a title", () => {
    upsertTopics(t.mirror, [{ chat: SUPERGROUP, id: 2 }], NOW)
    expect(rowsOf(t.mirror, "SELECT * FROM topics")).toEqual([
      { chat: SUPERGROUP, id: 2, title: null, closed: 0, updated: NOW },
    ])
    upsertTopics(t.mirror, [{ chat: SUPERGROUP, id: 2, title: "Before" }], NOW)
    upsertTopics(t.mirror, [{ chat: SUPERGROUP, id: 2, title: null }], NOW)
    expect(rowsOf(t.mirror, "SELECT title FROM topics")).toEqual([{ title: null }])
  })

  test("keeps the same id in different chats apart and skips a topic without a chat or id", () => {
    upsertTopics(
      t.mirror,
      [
        { chat: SUPERGROUP, id: 2, title: "A", closed: false },
        { chat: GROUP, id: 2, title: "B", closed: false },
        { chat: "", id: 3, title: "C", closed: false },
        { chat: SUPERGROUP, id: 1.5, title: "D", closed: false },
      ],
      NOW,
    )
    expect(rowsOf(t.mirror, "SELECT chat, title FROM topics ORDER BY chat")).toEqual([
      { chat: SUPERGROUP, title: "A" },
      { chat: GROUP, title: "B" },
    ])
  })
})
