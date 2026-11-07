import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { RESULT_BUDGET } from "../pages"
import { GROUP, USER } from "../telegram/mirror.testing"
import { at, createChatFixture, type ChatFixture } from "./read.testing"

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

let t: ChatFixture

beforeEach(() => {
  t = createChatFixture()
  t.follow({ id: USER, name: "Alice Example" })
})

afterEach(() => {
  t.close()
})

const size = (result: unknown) => JSON.stringify(result).length

describe("chat read: the size of a result", () => {
  test("many long messages come back as fewer items and a next, and the pages cover them all", async () => {
    const sent = Array.from({ length: 60 }, (_, n) => `m${n} ${"x".repeat(2000)}`)
    sent.forEach((body, n) => t.store({ id: n + 1, ts: at(n), body }))
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const result = await t.read({ method: "view", chat: USER, ...(cursor ? { cursor } : {}) })
      expect(size(result)).toBeLessThan(RESULT_BUDGET)
      expect(result.messages?.length).toBeLessThan(50)
      seen.unshift(...(result.messages ?? []).map((message) => message.text ?? ""))
      cursor = result.next
      pages += 1
    } while (cursor)
    expect(pages).toBeGreaterThan(2)
    expect(seen).toEqual(sent)
  })

  test("text is never cut while the messages fit in a result, however long", async () => {
    const long = "y".repeat(10_000)
    t.store({ id: 1, body: long }, { id: 2, body: "short" })
    const messages = await t.messages(USER)
    expect(messages.map((message) => message.text)).toEqual([long, "short"])
    expect(messages.some((message) => "text_cut" in message)).toBe(false)
  })

  test("a message that alone exceeds the budget has its text cut to fit and says so", async () => {
    const long = `${'Ünï"\n🙂'.repeat(30_000)}`
    t.store({ id: 1, body: "older" }, { id: 2, body: long })
    const result = await t.read({ method: "view", chat: USER, limit: 1 })
    expect(result.messages).toHaveLength(1)
    const [message] = result.messages ?? []
    expect(message?.text_cut).toBe(true)
    expect(long.startsWith(message?.text ?? "x")).toBe(true)
    expect(message?.text?.length).toBeGreaterThan(1000)
    expect(LONE_SURROGATE.test(message?.text ?? "")).toBe(false)
    expect(size(result)).toBeLessThan(RESULT_BUDGET)
    expect(result.next).toBeDefined()
    const older = await t.read({ method: "view", chat: USER, cursor: result.next })
    expect(older.messages?.map((entry) => entry.text)).toEqual(["older"])
  })

  test("an oversized message cuts its earlier versions only after its text", async () => {
    t.store({ id: 1, ts: at(0), body: "z".repeat(10) })
    t.store({ id: 1, ts: at(0), body: "new", edited: at(1) })
    t.store({ id: 1, ts: at(0), body: "newer", edited: at(2) })
    t.mirror.prepare("UPDATE edits SET body = ? WHERE seq = 1").run("v".repeat(60_000))
    const [message] = await t.messages(USER)
    expect(message?.text).toBe("newer")
    expect(message?.earlier_versions?.[0]?.text?.length).toBeLessThan(60_000)
    expect(message?.earlier_versions?.[0]?.text?.length).toBeGreaterThan(1000)
    expect(message?.text_cut).toBe(true)
  })

  test("a list with long last messages returns fewer chats and a next that continues", async () => {
    const chats = Array.from({ length: 30 }, (_, n) => String(2000 + n))
    chats.forEach((id, n) => {
      t.follow({ id, name: `Chat ${n}`, username: null })
      t.store({ chat: id, id: 1, ts: at(n), sender: id, body: "w".repeat(5000) })
    })
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const result = await t.read({ method: "list", last: true, limit: 200, ...(cursor ? { cursor } : {}) })
      expect(size(result)).toBeLessThan(RESULT_BUDGET)
      expect(result.chats?.length).toBeLessThan(31)
      seen.push(...(result.chats ?? []).map((chat) => chat.id))
      cursor = result.next
    } while (cursor)
    expect(seen).toEqual([...[...chats].reverse(), USER])
  })

  test("a chat whose last message alone exceeds the budget is cut in the list", async () => {
    t.store({ id: 1, body: "v".repeat(80_000) })
    const result = await t.read({ method: "list", last: true })
    expect(result.chats?.[0]?.last_message?.text_cut).toBe(true)
    expect(size(result)).toBeLessThan(RESULT_BUDGET)
  })

  const manyLinks = (count: number) => {
    const body = "link ".repeat(count)
    const entities = Array.from({ length: count }, (_, n) => ({
      type: "text_link",
      offset: n * 5,
      length: 4,
      url: `https://example.com/${n}/${"p".repeat(60)}`,
    }))
    return { body, entities }
  }

  test("a message whose links alone exceed the budget drops its metadata, keeps its text and says what it left out", async () => {
    t.store({ id: 1, ts: at(0), ...manyLinks(5000), reactions: [{ emoji: "👍", count: 1 }] })
    t.store({ id: 1, ts: at(0), ...manyLinks(5000), edited: at(1) })
    const result = await t.read({ method: "view", chat: USER })
    const [message] = result.messages ?? []
    expect(size(result)).toBeLessThan(RESULT_BUDGET)
    expect(message?.text).toBe("link ".repeat(5000))
    expect(message).toMatchObject({ text_cut: true, omitted: ["earlier_versions", "reactions", "links"] })
    for (const field of ["links", "earlier_versions", "reactions"]) expect(message).not.toHaveProperty(field)
  })

  test("a metadata drop in a list keeps the chat and its other fields", async () => {
    t.store({ id: 1, ...manyLinks(5000) })
    const result = await t.read({ method: "list", last: true })
    expect(size(result)).toBeLessThan(RESULT_BUDGET)
    expect(result.chats?.[0]?.last_message).toMatchObject({ omitted: ["links"], text_cut: true })
    expect(result.chats?.[0]).toMatchObject({ id: USER, name: "Alice Example", unread: 1 })
  })

  test("a huge group title is cut in a list and in a view, and says so", async () => {
    const title = `${"T".repeat(999)}😀${"t".repeat(60_000)}`
    t.follow({ id: GROUP, kind: "group", name: title })
    t.store({ chat: GROUP, id: 1, body: "hi" })
    const list = await t.read({ method: "list", query: "ttt" })
    const view = await t.read({ method: "view", chat: GROUP })
    for (const named of [list.chats?.[0], view.chat]) {
      expect(named?.name).toBe("T".repeat(999))
      expect(named?.name_cut).toBe(true)
    }
    expect(size(list)).toBeLessThan(RESULT_BUDGET)
    expect(size(view)).toBeLessThan(RESULT_BUDGET)
    expect(LONE_SURROGATE.test(JSON.stringify([list, view]))).toBe(false)
    expect(view.messages?.[0]?.text).toBe("hi")
  })
})
