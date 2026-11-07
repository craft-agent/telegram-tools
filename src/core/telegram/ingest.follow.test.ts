import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { setFollowed, upsertChats, upsertTopics } from "./ingest-chats"
import { storeMessage } from "./ingest-messages"
import {
  NOW,
  OTHER_USER,
  SUPERGROUP,
  USER,
  chatInput,
  chatRow,
  columnOf,
  createTestMirror,
  followChat,
  messageInput,
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

function store(chat: string, id: number, edited: number | null = null) {
  return storeMessage(t.mirror, t.ctx(), messageInput({ chat, id, edited }))
}

describe("setFollowed", () => {
  test("follows a known chat, so its messages are stored", () => {
    upsertChats(t.mirror, [chatInput()], NOW)
    expect(store(USER, 1)).toBe("dropped-unfollowed")
    setFollowed(t.mirror, USER, true)
    expect(chatRow(t.mirror, USER)?.followed).toBe(1)
    expect(store(USER, 1)).toBe("stored")
  })

  test("unfollowing drops the chat's messages and edits, and no other chat's", () => {
    followChat(t)
    followChat(t, { id: OTHER_USER, name: "Bob Example", username: null })
    store(USER, 1)
    store(USER, 1, NOW - 1000)
    store(OTHER_USER, 1)
    store(OTHER_USER, 1, NOW - 1000)
    setFollowed(t.mirror, USER, false)
    expect(columnOf(t.mirror, "SELECT chat FROM messages")).toEqual([OTHER_USER])
    expect(columnOf(t.mirror, "SELECT chat FROM edits")).toEqual([OTHER_USER])
  })

  test("unfollowing keeps the chat's row and topics, and stops storing", () => {
    followChat(t, { id: SUPERGROUP, kind: "supergroup", username: null, forum: true })
    upsertTopics(t.mirror, [{ chat: SUPERGROUP, id: 2, title: "Talk", closed: false }], NOW)
    storeMessage(t.mirror, t.ctx(), messageInput({ chat: SUPERGROUP, topic: 2 }))
    setFollowed(t.mirror, SUPERGROUP, false)
    expect(chatRow(t.mirror, SUPERGROUP)).toMatchObject({ followed: 0, forum: 1, top_id: 1 })
    expect(columnOf(t.mirror, "SELECT title FROM topics")).toEqual(["Talk"])
    expect(columnOf(t.mirror, "SELECT id FROM messages")).toEqual([])
    expect(storeMessage(t.mirror, t.ctx(), messageInput({ chat: SUPERGROUP, id: 2 }))).toBe("dropped-unfollowed")
  })

  test("a chat that has been left keeps its history", () => {
    followChat(t)
    store(USER, 1)
    upsertChats(t.mirror, [chatInput({ left: true })], NOW)
    expect(chatRow(t.mirror, USER)).toMatchObject({ left: 1, followed: 1 })
    expect(columnOf(t.mirror, "SELECT id FROM messages")).toEqual([1])
    expect(store(USER, 2)).toBe("stored")
  })

  test("does nothing for a chat the mirror does not know", () => {
    setFollowed(t.mirror, USER, true)
    setFollowed(t.mirror, "", true)
    expect(rowsOf(t.mirror, "SELECT id FROM chats")).toEqual([])
  })

  test("following again, or unfollowing twice, changes nothing more", () => {
    followChat(t)
    store(USER, 1)
    setFollowed(t.mirror, USER, true)
    expect(columnOf(t.mirror, "SELECT id FROM messages")).toEqual([1])
    setFollowed(t.mirror, USER, false)
    setFollowed(t.mirror, USER, false)
    expect(columnOf(t.mirror, "SELECT id FROM messages")).toEqual([])
    expect(chatRow(t.mirror, USER)?.followed).toBe(0)
  })
})
