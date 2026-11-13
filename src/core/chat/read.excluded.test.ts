import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { labelPaths } from "../telegram/labels"
import { CHANNEL, GROUP, NOW, OTHER_USER, SUPERGROUP, USER } from "../telegram/mirror.testing"
import { readMirror } from "../open"
import { invoke } from "../tool"
import { excludingContext } from "./excluded.testing"
import { telegramChatRead } from "./read"
import { createChatFixture, fillSampleChats, type ChatFixture } from "./read.testing"
import type { ChatReadOutput } from "./schema"
import { searchMessages, type ScanLimits } from "./search"

let t: ChatFixture

beforeEach(() => {
  t = createChatFixture()
})

afterEach(() => {
  t.close()
})

/** Calls the tool with the `exclude_chats` setting holding `excluded`. */
const readWithout = (excluded: string[], args: Record<string, unknown>) =>
  invoke(telegramChatRead, args, excludingContext(t.stateDir, excluded))

const listWithout = async (excluded: string[], args: Record<string, unknown> = {}) =>
  readWithout(excluded, { method: "list", ...args })

const ids = (page: Pick<ChatReadOutput, "chats">) => page.chats?.map((chat) => chat.id)

describe("chat read: list leaves excluded chats out", () => {
  test("an excluded chat is not listed, and a page is still full from the chats that remain", async () => {
    fillSampleChats(t)
    expect(ids(await listWithout([USER, GROUP]))).toEqual([OTHER_USER, SUPERGROUP, CHANNEL])
    const first = await listWithout([USER], { limit: 2 })
    expect(ids(first)).toEqual([OTHER_USER, GROUP])
    expect(first.next).toBeDefined()
    const rest = await listWithout([USER], { limit: 2, cursor: first.next })
    expect(ids(rest)).toEqual([SUPERGROUP, CHANNEL])
    expect(rest.next).toBeUndefined()
  })

  test("the last message of a listed chat is shown, and none of an excluded chat is read", async () => {
    fillSampleChats(t)
    const page = await listWithout([USER], { last: true })
    expect(page.chats?.[0]).toMatchObject({ id: OTHER_USER, last_message: { text: "hello from Bob" } })
    expect(JSON.stringify(page)).not.toContain("hello from Alice")
  })

  test("with no chat excluded the list is as it was", async () => {
    fillSampleChats(t)
    expect(ids(await listWithout([]))).toEqual(ids(await t.read({ method: "list" })))
  })

  test("a cursor taken without the setting is refused with it, and one taken with it without", async () => {
    fillSampleChats(t)
    const open = await t.read({ method: "list", limit: 1 })
    await expect(listWithout([GROUP], { limit: 1, cursor: open.next })).rejects.toMatchObject({
      code: "invalid_argument",
      message: "cursor is not a cursor this tool returned.",
    })
    const closed = await listWithout([GROUP], { limit: 1 })
    await expect(t.read({ method: "list", limit: 1, cursor: closed.next })).rejects.toMatchObject({
      code: "invalid_argument",
    })
    await expect(listWithout([USER], { limit: 1, cursor: closed.next })).rejects.toMatchObject({
      code: "invalid_argument",
    })
  })

  test("the order the setting lists its chats in does not change its cursors", async () => {
    fillSampleChats(t)
    const first = await listWithout([GROUP, SUPERGROUP], { limit: 1 })
    expect(ids(await listWithout([SUPERGROUP, GROUP], { limit: 1, cursor: first.next }))).toEqual([OTHER_USER])
  })
})

/** Calls the search itself, with the scan limits of the test's own. */
function search(excluded: string[], args: Record<string, unknown>, scan?: ScanLimits) {
  return readMirror(labelPaths(t.stateDir, "default"), (mirror) =>
    searchMessages(mirror, { query: "needle", ...args }, Date.now(), new Set(excluded), scan),
  )
}

const texts = (page: Pick<ChatReadOutput, "messages">) => page.messages?.map((message) => message.text)

describe("chat read: search leaves excluded chats out", () => {
  beforeEach(() => {
    t.follow({ id: USER, name: "Alice Example" })
    t.follow({ id: OTHER_USER, name: "Bob Example", username: null })
  })

  test("a search across chats returns no message of an excluded chat", async () => {
    t.store(
      { chat: USER, id: 1, ts: NOW, body: "needle alice" },
      { chat: OTHER_USER, id: 1, ts: NOW + 1, body: "needle bob" },
    )
    const page = await readWithout([OTHER_USER], { method: "search", query: "needle" })
    expect(texts(page)).toEqual(["needle alice"])
    expect(JSON.stringify(page)).not.toContain("Bob Example")
  })

  test("excluded messages take no part of the scan, and no place in a page or a cursor", () => {
    t.store({ chat: USER, id: 1, ts: NOW, body: "needle alice" })
    t.mirror.exec("BEGIN")
    const insert = t.mirror.prepare(
      "INSERT INTO messages (chat, id, ts, kind, body, received) VALUES (?, ?, ?, 'message', 'needle bob', ?)",
    )
    for (let n = 0; n < 12; n += 1) insert.run(OTHER_USER, 100 + n, NOW + 1 + n, NOW)
    t.mirror.exec("COMMIT")
    const scan = { chunk: 3, maxScanned: 3 }
    expect(search([], {}, scan).scanned_to).toBeDefined()
    const page = search([OTHER_USER], {}, scan)
    expect(texts(page)).toEqual(["needle alice"])
    expect(page.scanned_to).toBeUndefined()
    expect(page.next).toBeUndefined()
    const full = search([OTHER_USER], { limit: 1 }, scan)
    expect(texts(full)).toEqual(["needle alice"])
    expect(full.next).toBeUndefined()
  })

  test("a cursor taken without the setting is refused with it, and one taken with it without", () => {
    t.store(
      { chat: USER, id: 1, ts: NOW, body: "needle alice" },
      { chat: USER, id: 2, ts: NOW + 1, body: "needle again" },
    )
    const open = search([], { limit: 1 })
    expect(open.next).toBeDefined()
    expect(() => search([OTHER_USER], { limit: 1, cursor: open.next })).toThrow("cursor is not a cursor")
    const closed = search([OTHER_USER], { limit: 1 })
    expect(closed.next).toBeDefined()
    expect(() => search([], { limit: 1, cursor: closed.next })).toThrow("cursor is not a cursor")
    expect(texts(search([OTHER_USER], { limit: 1, cursor: closed.next }))).toEqual(["needle alice"])
  })
})
