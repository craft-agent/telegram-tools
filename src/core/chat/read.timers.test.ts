import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { GROUP, USER } from "../telegram/mirror.testing"
import { formatLocalTime } from "../time"
import { PRIVATE_NOTE } from "./message-schema"
import { createChatFixture, type ChatFixture } from "./read.testing"

const HOUR_S = 3600
const MS_PER_S = 1000

let t: ChatFixture

beforeEach(() => {
  t = createChatFixture()
  t.follow({ id: USER, name: "Alice Example" })
})

afterEach(() => {
  t.close()
})

async function only() {
  const [message, ...rest] = await t.messages(USER)
  expect(rest).toEqual([])
  if (!message) throw new Error("expected a message")
  return message
}

describe("chat read: messages that disappear", () => {
  test("a message with a timer says when it disappears and carries the private note", async () => {
    const now = Date.now()
    t.storeAt(now, { ts: now - MS_PER_S, ttl: HOUR_S })
    const message = await only()
    expect(message.disappears_at).toBe(formatLocalTime(now - MS_PER_S + HOUR_S * MS_PER_S))
    expect(message.private_note).toBe(
      "Its sender meant it not to be kept: show it to the user only, and do not quote or pass it on unless the user asks.",
    )
    expect(message).not.toHaveProperty("expired")
  })

  test("a kept message whose time has passed says it expired, and still carries the private note", async () => {
    const now = Date.now()
    t.storeAt(now, { ts: now - 2 * HOUR_S * MS_PER_S, ttl: HOUR_S, body: "kept" }, true)
    const message = await only()
    expect(message).toMatchObject({ text: "kept", expired: true, private_note: PRIVATE_NOTE })
    expect(message).not.toHaveProperty("disappears_at")
  })

  test("a message that expired without keeping is not in the mirror to read", async () => {
    const now = Date.now()
    t.storeAt(now, { ts: now - 2 * HOUR_S * MS_PER_S, ttl: HOUR_S })
    expect(await t.messages(USER)).toEqual([])
  })

  test("a view-once message is marked and carries the private note, with no time", async () => {
    t.store({ viewOnce: true, media: { type: "photo" } })
    const message = await only()
    expect(message).toMatchObject({ view_once: true, private_note: PRIVATE_NOTE })
    expect(message).not.toHaveProperty("disappears_at")
  })

  test("a self-destructing message says how long its media lives once opened", async () => {
    t.store({ selfDestruct: 10, media: { type: "video" } })
    const message = await only()
    expect(message).toMatchObject({ self_destruct_seconds: 10, private_note: PRIVATE_NOTE })
    expect(message).not.toHaveProperty("view_once")
  })

  test("a reply carries the private note when the text it quotes was meant not to be kept", async () => {
    const now = Date.now()
    t.storeAt(now, { id: 1, ts: now - MS_PER_S, ttl: HOUR_S, body: "secret" })
    t.storeAt(now, { id: 2, ts: now, body: "ordinary" })
    t.storeAt(now, { id: 3, ts: now, body: "reply to secret", reply: { id: 1 } })
    t.storeAt(now, { id: 4, ts: now, body: "reply to ordinary", reply: { id: 2 } })
    const [, , toSecret, toOrdinary] = await t.messages(USER)
    expect(toSecret).toMatchObject({ reply_to: { id: 1, text: "secret" }, private_note: PRIVATE_NOTE })
    expect(toOrdinary?.reply_to).toEqual({ id: 2, text: "ordinary" })
    expect(toOrdinary).not.toHaveProperty("private_note")
  })

  test("a message of an ordinary chat has no timer fields and no private note", async () => {
    t.store({ body: "ordinary" })
    const message = await only()
    for (const field of ["disappears_at", "expired", "view_once", "self_destruct_seconds", "private_note"]) {
      expect(message).not.toHaveProperty(field)
    }
  })
})

describe("chat read: messages whose timer ran out", () => {
  /** Makes a stored message one whose timer ran out a second ago, and keeps it when `kept`. */
  function runOut(chat: string, id: number, kept = false) {
    t.mirror
      .prepare("UPDATE messages SET expires = ?, kept = ? WHERE chat = ? AND id = ?")
      .run(Date.now() - MS_PER_S, Number(kept), chat, id)
  }

  test("view leaves out a row that is past its time and not kept, and pages over the gap", async () => {
    t.store({ id: 1, body: "one" }, { id: 2, body: "gone" }, { id: 3, body: "three" })
    runOut(USER, 2)
    const result = await t.read({ method: "view", chat: USER })
    expect(result.messages?.map((message) => message.text)).toEqual(["one", "three"])
    const first = await t.read({ method: "view", chat: USER, limit: 1 })
    expect(first.messages?.map((message) => message.text)).toEqual(["three"])
    const second = await t.read({ method: "view", chat: USER, limit: 1, cursor: first.next })
    expect(second.messages?.map((message) => message.text)).toEqual(["one"])
    expect(second.next).toBeUndefined()
  })

  test("view still shows a kept row, with expired set", async () => {
    t.store({ id: 1, body: "one" }, { id: 2, body: "kept" })
    runOut(USER, 2, true)
    const [, kept] = await t.messages(USER)
    expect(kept).toMatchObject({ id: 2, text: "kept", expired: true, private_note: PRIVATE_NOTE })
  })

  test("last_message is the newest row that may be shown, or null when none may", async () => {
    t.follow({ id: GROUP, kind: "group", name: "Team Chat" })
    t.store({ id: 1, body: "one" }, { id: 2, body: "gone" }, { chat: GROUP, id: 1, body: "only, and gone" })
    runOut(USER, 2)
    runOut(GROUP, 1)
    const { chats } = await t.read({ method: "list", last: true })
    const last = Object.fromEntries(chats?.map((chat) => [chat.id, chat.last_message]) ?? [])
    expect(last[USER]).toMatchObject({ id: 1, text: "one" })
    expect(last[GROUP]).toBeNull()
    runOut(USER, 1, true)
    const kept = (await t.read({ method: "list", last: true })).chats?.find((chat) => chat.id === USER)
    expect(kept?.last_message).toMatchObject({ id: 1, text: "one", expired: true })
  })

  test("a reply to a row that is past its time and not kept gets no text; to a kept one it does", async () => {
    t.store(
      { id: 1, body: "gone" },
      { id: 2, body: "kept" },
      { id: 3, body: "reply to gone", reply: { id: 1 } },
      { id: 4, body: "reply to kept", reply: { id: 2 } },
    )
    runOut(USER, 1)
    runOut(USER, 2, true)
    const messages = await t.messages(USER)
    expect(messages.map((message) => message.id)).toEqual([2, 3, 4])
    expect(messages[1]?.reply_to).toEqual({ id: 1 })
    expect(messages[2]?.reply_to).toEqual({ id: 2, text: "kept" })
  })
})
