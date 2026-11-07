import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, statSync } from "node:fs"
import { ToolError } from "../errors"
import { labelPaths } from "../telegram/labels"
import { OTHER_USER, USER } from "../telegram/mirror.testing"
import { formatLocalTime } from "../time"
import { at, createChatFixture, type ChatFixture, type ServiceCalls } from "./read.testing"

let t: ChatFixture
let calls: ServiceCalls

beforeEach(() => {
  t = createChatFixture()
  t.follow({ id: USER, name: "Alice Example" })
  t.store({ id: 1, ts: at(1), body: "hello" })
})

afterEach(async () => {
  await t.stopServices()
  t.close()
})

const chatIds = (result: { chats?: { id: string }[] }) => result.chats?.map((chat) => chat.id)

describe("chat read: list with refresh", () => {
  test("asks the service to refresh with no parameters, then reads the refreshed mirror", async () => {
    calls = await t.serve({
      refresh: () => {
        t.follow({ id: OTHER_USER, name: "Bob Example" })
        return { refreshed_at: at(7) }
      },
    })
    const result = await t.read({ method: "list", refresh: true })
    expect(calls).toEqual([{ method: "refresh", params: undefined }])
    expect(result.refreshed_at).toBe(formatLocalTime(at(7)))
    expect(chatIds(result)).toEqual([USER, OTHER_USER])
  })

  test("a list without refresh, or with refresh false, sends no request", async () => {
    calls = await t.serve({ refresh: () => ({ refreshed_at: at(7) }) })
    const plain = await t.read({ method: "list" })
    const off = await t.read({ method: "list", refresh: false })
    expect(calls).toEqual([])
    expect(plain).not.toHaveProperty("refreshed_at")
    expect(off).not.toHaveProperty("refreshed_at")
  })

  test("the filters and paging of the list apply after the refresh", async () => {
    calls = await t.serve({ refresh: () => ({ refreshed_at: at(7) }) })
    const result = await t.read({ method: "list", refresh: true, query: "ali", last: true })
    expect(chatIds(result)).toEqual([USER])
    expect(result.chats?.[0]?.last_message).toMatchObject({ text: "hello" })
    expect(result.refreshed_at).toBeDefined()
  })

  test("without the service a refresh is the client's error, while a plain list still works", async () => {
    const error = await t.failure({ method: "list", refresh: true })
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("sync service is not running")
    expect(chatIds(await t.read({ method: "list" }))).toEqual([USER])
  })

  test("a bad limit or cursor is refused before the service is asked to refresh", async () => {
    calls = await t.serve({ refresh: () => ({ refreshed_at: at(7) }) })
    expect((await t.failure({ method: "list", refresh: true, limit: 0 })).code).toBe("invalid_argument")
    expect((await t.failure({ method: "list", refresh: true, cursor: "nonsense" })).code).toBe("invalid_argument")
    expect(calls).toEqual([])
  })

  test("the service's errors pass through", async () => {
    calls = await t.serve({
      refresh: () => {
        throw new ToolError("unauthenticated", "The session has ended; log in again.")
      },
    })
    const error = await t.failure({ method: "list", refresh: true })
    expect(error).toMatchObject({ code: "unauthenticated", message: "The session has ended; log in again." })
  })

  test("a refresh leaves the mirror file as it was when the service writes nothing", async () => {
    calls = await t.serve({ refresh: () => ({ refreshed_at: at(7) }) })
    t.closeMirror()
    const path = labelPaths(t.stateDir, "default").mirror
    const before = statSync(path)
    await t.read({ method: "list", refresh: true })
    const after = statSync(path)
    expect([after.mtimeMs, after.size]).toEqual([before.mtimeMs, before.size])
    expect(existsSync(`${path}-wal`)).toBe(false)
  })
})
