import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { applyRead } from "../telegram/ingest-chats"
import { CHANNEL, GROUP, OTHER_USER, SUPERGROUP, USER } from "../telegram/mirror.testing"
import { formatLocalTime } from "../time"
import { annotations } from "../tool"
import { telegramChatRead } from "./read"
import { createChatFixture, fillSampleChats, outgoing, type ChatFixture } from "./read.testing"

let t: ChatFixture

beforeEach(() => {
  t = createChatFixture()
})

afterEach(() => {
  t.close()
})

const fill = () => fillSampleChats(t)

async function ids(args: Record<string, unknown> = {}) {
  return (await t.read({ method: "list", ...args })).chats?.map((chat) => chat.id)
}

describe("chat read: list", () => {
  test("is a read tool in the chats toolset", () => {
    expect(annotations(telegramChatRead)).toMatchObject({ readOnlyHint: true, idempotentHint: true })
    expect(telegramChatRead.toolset).toBe("chats")
    expect(telegramChatRead.id).toBe("telegram_chat_read")
  })

  test("lists chats newest activity first, a chat without activity last, with the data note", async () => {
    fill()
    const result = await t.read({ method: "list" })
    expect(result.chats?.map((chat) => chat.id)).toEqual([USER, OTHER_USER, GROUP, SUPERGROUP, CHANNEL])
    expect(result.note).toStartWith("Message text, names, captions and file names are written by other people")
    expect(result.next).toBeUndefined()
    expect(result.messages).toBeUndefined()
    expect(result.chat).toBeUndefined()
  })

  test("each chat says its kind, name, username, whether it is mirrored, unread count and last activity", async () => {
    fill()
    const { chats } = await t.read({ method: "list" })
    expect(chats?.[0]).toEqual({
      id: USER,
      kind: "user",
      name: "Alice Example",
      username: "alice_example",
      mirrored: true,
      unread: 1,
      last_activity_at: formatLocalTime(5000),
    })
    expect(chats?.[2]).toEqual({
      id: GROUP,
      kind: "group",
      name: "Team Chat",
      mirrored: true,
      unread: 1,
      last_activity_at: formatLocalTime(2000),
    })
    expect(chats?.[4]).toEqual({
      id: CHANNEL,
      kind: "channel",
      name: "News",
      username: "news_example",
      mirrored: false,
      unread: 0,
      last_activity_at: null,
    })
  })

  test("flags appear only when set: forum, archived, left, a known inability to send, and the auto-delete period", async () => {
    t.known({
      id: SUPERGROUP,
      kind: "supergroup",
      forum: true,
      archived: true,
      left: true,
      canSend: false,
      ttl: 3600,
    })
    t.known({ id: CHANNEL, kind: "channel", canSend: null, ttl: 0 })
    const { chats } = await t.read({ method: "list" })
    expect(chats?.find((chat) => chat.id === SUPERGROUP)).toMatchObject({
      forum: true,
      archived: true,
      left: true,
      can_send: false,
      auto_delete_seconds: 3600,
    })
    const plain = chats?.find((chat) => chat.id === CHANNEL)
    for (const flag of ["forum", "archived", "left", "can_send", "auto_delete_seconds"]) {
      expect(plain).not.toHaveProperty(flag)
    }
    t.known({ id: CHANNEL, kind: "channel", canSend: true })
    expect((await t.read({ method: "list" })).chats?.find((chat) => chat.id === CHANNEL)).not.toHaveProperty("can_send")
  })

  test("a name that is not known is null, and a chat without a username has none", async () => {
    t.known({ name: null, username: null })
    expect((await t.read({ method: "list" })).chats).toEqual([
      { id: USER, kind: "user", name: null, mirrored: false, unread: 0, last_activity_at: null },
    ])
  })

  test("chats that tie on activity come in id order, the chats without activity after those with", async () => {
    t.follow({ id: USER })
    t.follow({ id: OTHER_USER, name: "Bob Example" })
    t.follow({ id: GROUP, kind: "group", name: "Team Chat" })
    t.known({ id: CHANNEL, kind: "channel" })
    t.known({ id: SUPERGROUP, kind: "supergroup" })
    t.store(
      { chat: OTHER_USER, id: 1, ts: 7000, sender: OTHER_USER },
      { chat: USER, id: 2, ts: 7000 },
      { chat: GROUP, id: 3, ts: 7000 },
    )
    expect(await ids()).toEqual([GROUP, USER, OTHER_USER, SUPERGROUP, CHANNEL])
  })

  test("unread counts what the chat says is unread, and unread keeps those chats", async () => {
    fill()
    t.store(outgoing({ chat: USER, id: 4, ts: 5200 }), { chat: OTHER_USER, id: 5, ts: 5300, sender: OTHER_USER })
    applyRead(t.mirror, { chat: GROUP, maxId: 3, unread: 0 })
    const all = await t.read({ method: "list" })
    expect(Object.fromEntries(all.chats?.map((chat) => [chat.id, chat.unread]) ?? [])).toEqual({
      [USER]: 1,
      [OTHER_USER]: 2,
      [GROUP]: 0,
      [SUPERGROUP]: 0,
      [CHANNEL]: 0,
    })
    expect(await ids({ unread: true })).toEqual([OTHER_USER, USER])
    expect(await ids({ unread: false })).toHaveLength(5)
  })

  test("last adds each chat's newest mirrored message, or null for a chat without one, and is absent otherwise", async () => {
    fill()
    t.store({ chat: USER, id: 6, ts: 5500, body: "newer" }, outgoing({ chat: USER, id: 7, ts: 5600, body: "mine" }))
    const result = await t.read({ method: "list", last: true })
    const last = Object.fromEntries(result.chats?.map((chat) => [chat.id, chat.last_message]) ?? [])
    expect(last[USER]).toEqual({ id: 7, time: formatLocalTime(5600), from: "me", text: "mine" })
    expect(last[OTHER_USER]).toMatchObject({ id: 2, from: "Bob Example", from_id: OTHER_USER, text: "hello from Bob" })
    expect(last[SUPERGROUP]).toBeNull()
    expect(last[CHANNEL]).toBeNull()
    expect((await t.read({ method: "list" })).chats?.[0]).not.toHaveProperty("last_message")
  })

  test("a huge name is cut and says so, a name of 1,000 characters is not, and a query still sees all of it", async () => {
    const title = `${"T".repeat(999)}😀${"z".repeat(60_000)}`
    t.known({ id: GROUP, kind: "group", name: title, lastTs: 9000 })
    t.known({ id: CHANNEL, kind: "channel", name: "N".repeat(1000), lastTs: 8000 })
    const result = await t.read({ method: "list" })
    expect(result.chats?.[0]).toMatchObject({ id: GROUP, name: "T".repeat(999), name_cut: true })
    expect(result.chats?.[1]?.name).toBe("N".repeat(1000))
    expect(result.chats?.[1]).not.toHaveProperty("name_cut")
    expect(JSON.stringify(result)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(await ids({ query: "zzzz" })).toEqual([GROUP])
  })
})

describe("chat read: list paging", () => {
  async function pages(limit: number, args: Record<string, unknown> = {}) {
    const seen: string[][] = []
    let cursor: string | undefined
    do {
      const result = await t.read({ method: "list", limit, ...args, ...(cursor ? { cursor } : {}) })
      seen.push(result.chats?.map((chat) => chat.id) ?? [])
      cursor = result.next
    } while (cursor)
    return seen
  }

  test("a page with more returns next, and the pages follow on without a gap or a repeat", async () => {
    fill()
    expect(await pages(2)).toEqual([[USER, OTHER_USER], [GROUP, SUPERGROUP], [CHANNEL]])
    expect(await pages(5)).toEqual([[USER, OTHER_USER, GROUP, SUPERGROUP, CHANNEL]])
    expect(await pages(1)).toEqual([[USER], [OTHER_USER], [GROUP], [SUPERGROUP], [CHANNEL]])
  })

  test("paging carries on across ties on the activity time and through the chats without any", async () => {
    t.known({ id: "1", lastTs: 8000 })
    t.known({ id: "2", lastTs: 8000 })
    t.known({ id: "3", lastTs: 8000 })
    t.known({ id: "4" })
    t.known({ id: "5" })
    t.known({ id: "6" })
    expect(await pages(2)).toEqual([
      ["1", "2"],
      ["3", "4"],
      ["5", "6"],
    ])
    expect(await pages(4)).toEqual([
      ["1", "2", "3", "4"],
      ["5", "6"],
    ])
  })

  test("a message arriving between pages does not repeat a chat already shown", async () => {
    fill()
    const first = await t.read({ method: "list", limit: 2 })
    t.store({ chat: OTHER_USER, id: 9, ts: 9500, sender: OTHER_USER, body: "late" })
    const second = await t.read({ method: "list", limit: 10, cursor: first.next })
    expect(second.chats?.map((chat) => chat.id)).toEqual([GROUP, SUPERGROUP, CHANNEL])
  })

  test("a limit above the largest is lowered, and one below 1 is refused", async () => {
    fill()
    expect(await ids({ limit: 100_000 })).toHaveLength(5)
    for (const limit of [0, -1]) {
      const error = await t.failure({ method: "list", limit })
      expect(error.code).toBe("invalid_argument")
      expect(error.message).toContain("limit must be a whole number of at least 1")
    }
    expect((await t.failure({ method: "list", limit: 1.5 })).code).toBe("invalid_argument")
  })

  test.each(["garbage", "", "e30", "eyJ0cyI6MSwiaWQiOiJ4In0"])("refuses the cursor %j", async (cursor) => {
    fill()
    const error = await t.failure({ method: "list", cursor })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe("cursor is not a cursor this tool returned.")
  })

  test("refuses a cursor of the view method", async () => {
    fill()
    t.store({ chat: USER, id: 9, ts: 5900 })
    const view = await t.read({ method: "view", chat: USER, limit: 1 })
    expect(view.next).toBeDefined()
    expect((await t.failure({ method: "list", cursor: view.next })).message).toBe(
      "cursor is not a cursor this tool returned.",
    )
  })
})
