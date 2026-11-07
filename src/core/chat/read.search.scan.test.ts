import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { RESULT_BUDGET } from "../pages"
import { labelPaths } from "../telegram/labels"
import { GROUP, NOW, OTHER_USER, USER } from "../telegram/mirror.testing"
import { formatLocalTime } from "../time"
import { readMirror } from "./open"
import { at, createChatFixture, type ChatFixture } from "./read.testing"
import { SCAN_LIMITS, searchMessages, type ScanLimits } from "./search"

let t: ChatFixture

beforeEach(() => {
  t = createChatFixture()
  t.follow({ id: USER, name: "Alice Example" })
})

afterEach(() => {
  t.close()
})

/** Calls the search itself, with scan limits of the test's own. */
function search(args: Record<string, unknown>, scan: ScanLimits) {
  return readMirror(labelPaths(t.stateDir, "default"), (mirror) =>
    searchMessages(mirror, { query: "needle", ...args }, Date.now(), scan),
  )
}

/** `count` messages of `USER`'s chat that hold no needle, one a millisecond from `from`, in one transaction. */
function filler(count: number, from: number) {
  const insert = t.mirror.prepare(
    "INSERT INTO messages (chat, id, ts, kind, body, received) VALUES (?, ?, ?, 'message', 'filler', ?)",
  )
  t.mirror.exec("BEGIN")
  for (let n = 0; n < count; n += 1) insert.run(USER, 1000 + n, from + n, NOW)
  t.mirror.exec("COMMIT")
}

const texts = (page: { messages?: { text?: string }[] }) => page.messages?.map((message) => message.text)

describe("chat read: how far a search looks", () => {
  beforeEach(() => {
    t.store({ id: 1, ts: NOW, body: "the needle" })
    filler(12, NOW + 1)
  })

  test("the limits are the real ones", () => {
    expect(SCAN_LIMITS).toEqual({ chunk: 1000, maxScanned: 20_000 })
  })

  test("stops after the most messages it may look through, says where, and continues from there", () => {
    const scan = { chunk: 3, maxScanned: 6 }
    const first = search({}, scan)
    expect(first.messages).toEqual([])
    expect(first.scanned_to).toBe(formatLocalTime(NOW + 7))
    expect(first.next).toBeDefined()
    const second = search({ cursor: first.next }, scan)
    expect(second.messages).toEqual([])
    expect(second.scanned_to).toBe(formatLocalTime(NOW + 1))
    const third = search({ cursor: second.next }, scan)
    expect(texts(third)).toEqual(["the needle"])
    expect(third.scanned_to).toBeUndefined()
    expect(third.next).toBeUndefined()
  })

  test("hits found before the bound come back with it, and the next continues from where it stopped", () => {
    t.store({ id: 2, ts: NOW + 100, body: "a needle" })
    const page = search({}, { chunk: 4, maxScanned: 6 })
    expect(texts(page)).toEqual(["a needle"])
    expect(page.scanned_to).toBe(formatLocalTime(NOW + 8))
    expect(texts(search({ cursor: page.next }, { chunk: 4, maxScanned: 20 }))).toEqual(["the needle"])
  })

  test("a full page does not look further, and says no scanned_to", () => {
    t.store({ id: 2, ts: NOW + 100, body: "a needle" }, { id: 3, ts: NOW + 101, body: "another needle" })
    const page = search({ limit: 1 }, { chunk: 2, maxScanned: 6 })
    expect(texts(page)).toEqual(["another needle"])
    expect(page.scanned_to).toBeUndefined()
    const rest = search({ limit: 5, cursor: page.next }, { chunk: 2, maxScanned: 6 })
    expect(texts(rest)).toEqual(["a needle"])
    expect(rest.scanned_to).toBe(formatLocalTime(NOW + 8))
  })

  test("reaching the bound exactly at the end of the history is the end, not a stop", () => {
    const page = search({}, { chunk: 5, maxScanned: 13 })
    expect(texts(page)).toEqual(["the needle"])
    expect(page.next).toBeUndefined()
    expect(page.scanned_to).toBeUndefined()
    const short = search({}, { chunk: 5, maxScanned: 12 })
    expect(short.messages).toEqual([])
    expect(short.scanned_to).toBe(formatLocalTime(NOW + 1))
  })

  test("a history that ends exactly with a chunk is the end", () => {
    expect(search({ query: "absent" }, { chunk: 13, maxScanned: 100 }).next).toBeUndefined()
    expect(search({ query: "absent" }, { chunk: 1, maxScanned: 100 }).next).toBeUndefined()
  })

  test("a chat limits what is looked through", () => {
    t.follow({ id: OTHER_USER, name: "Bob Example", username: null })
    t.store({ chat: OTHER_USER, id: 1, ts: NOW - 5, body: "bob needle" })
    const page = search({ chat: OTHER_USER }, { chunk: 1, maxScanned: 1 })
    expect(texts(page)).toEqual(["bob needle"])
    expect(page.next).toBeUndefined()
  })
})

describe("chat read: how a search crosses chunks", () => {
  test("messages of one moment in several chats are neither skipped nor repeated at a chunk's end", () => {
    t.follow({ id: OTHER_USER, name: "Bob Example", username: null })
    t.follow({ id: GROUP, kind: "group", name: "Team Chat", username: null })
    for (const chat of [USER, OTHER_USER, GROUP]) {
      t.store(...[1, 2, 3].map((id) => ({ chat, id, ts: NOW, body: `needle ${chat} ${id}` })))
    }
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = search({ limit: 100, ...(cursor ? { cursor } : {}) }, { chunk: 2, maxScanned: 2 })
      seen.push(...(page.messages ?? []).map((message) => message.text ?? ""))
      cursor = page.next
    } while (cursor)
    const expected = [OTHER_USER, USER, GROUP].flatMap((chat) => [3, 2, 1].map((id) => `needle ${chat} ${id}`))
    expect(seen).toEqual(expected)
  })
})

describe("chat read: how a search of one chat crosses chunks", () => {
  test("messages of one moment are neither skipped nor repeated at a chunk's end", () => {
    t.store(...[1, 2, 3, 4, 5].map((id) => ({ id, ts: NOW, body: `needle ${id}` })))
    t.store({ id: 6, ts: NOW - 1, body: "needle 6" })
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = search({ chat: USER, limit: 100, ...(cursor ? { cursor } : {}) }, { chunk: 2, maxScanned: 2 })
      seen.push(...(page.messages ?? []).map((message) => message.text ?? ""))
      cursor = page.next
    } while (cursor)
    expect(seen).toEqual(["needle 5", "needle 4", "needle 3", "needle 2", "needle 1", "needle 6"])
  })
})

describe("chat read: the size of search results", () => {
  test("hits that are long come back as fewer items and a next that continues", async () => {
    const bodies = Array.from({ length: 40 }, (_, n) => `needle ${n} ${"x".repeat(3000)}`)
    t.store(...bodies.map((body, n) => ({ id: n + 1, ts: at(n), body })))
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await t.read({ method: "search", query: "needle", ...(cursor ? { cursor } : {}) })
      expect(JSON.stringify(page).length).toBeLessThan(RESULT_BUDGET)
      expect(page.messages?.length).toBeLessThan(30)
      seen.push(...(page.messages ?? []).map((message) => message.text ?? ""))
      cursor = page.next
    } while (cursor)
    expect(seen).toEqual([...bodies].reverse())
  })

  test("a single hit that alone exceeds the budget is cut and says so", async () => {
    t.store({ id: 1, ts: at(1), body: `needle ${"y".repeat(80_000)}` }, { id: 2, ts: at(0), body: "needle" })
    const page = await t.read({ method: "search", query: "needle" })
    expect(page.messages?.[0]).toMatchObject({ text_cut: true, chat: USER })
    expect(JSON.stringify(page).length).toBeLessThan(RESULT_BUDGET)
    expect(page.next).toBeDefined()
    const rest = await t.read({ method: "search", query: "needle", cursor: page.next })
    expect(texts(rest)).toEqual(["needle"])
  })
})
