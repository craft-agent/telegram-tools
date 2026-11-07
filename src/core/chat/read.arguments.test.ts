import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs"
import { labelPaths } from "../telegram/labels"
import { openMirrorForWrite } from "../telegram/mirror"
import { MIRROR_VERSION } from "../telegram/mirror-schema"
import { GROUP, SUPERGROUP, USER, makeTempDir } from "../telegram/mirror.testing"
import { invoke } from "../tool"
import { telegramChatRead } from "./read"
import { createChatFixture, fillSampleChats, type ChatFixture } from "./read.testing"

let t: ChatFixture

beforeEach(() => {
  t = createChatFixture()
})

afterEach(async () => {
  await t.stopServices()
  t.close()
})

describe("chat read: arguments", () => {
  test.each([
    [
      { method: "list", chat: USER },
      "chat does not apply to the list method; it takes query, unread, last, refresh, limit, cursor",
    ],
    [{ method: "list", after: "2026-11-07" }, "after does not apply to the list method"],
    [{ method: "list", before: "2026-11-07" }, "before does not apply to the list method"],
    [{ method: "list", topic: 5 }, "topic does not apply to the list method"],
    [
      { method: "view", chat: USER, query: "x" },
      "query does not apply to the view method; it takes chat, topic, after, before, limit, cursor",
    ],
    [{ method: "view", chat: USER, unread: false }, "unread does not apply to the view method"],
    [{ method: "view", chat: USER, last: false }, "last does not apply to the view method"],
    [{ method: "view", chat: USER, refresh: false }, "refresh does not apply to the view method"],
    [
      { method: "topics", chat: SUPERGROUP, after: "2026-11-07" },
      "after does not apply to the topics method; it takes chat, limit, cursor",
    ],
    [{ method: "topics", chat: SUPERGROUP, topic: 1 }, "topic does not apply to the topics method"],
    [{ method: "topics", chat: SUPERGROUP, refresh: true }, "refresh does not apply to the topics method"],
    [{ method: "topics", chat: SUPERGROUP, query: "x" }, "query does not apply to the topics method"],
    [
      { method: "search", query: "x", topic: 1 },
      "topic does not apply to the search method; it takes query, chat, after, before, limit, cursor",
    ],
    [{ method: "search", query: "x", unread: false }, "unread does not apply to the search method"],
    [
      { method: "around", chat: USER, id: 1, limit: 5 },
      "limit does not apply to the around method; it takes chat, id, before_count, after_count, topic",
    ],
    [{ method: "view", chat: USER, before_count: 1 }, "before_count does not apply to the view method"],
    [{ method: "topics", chat: SUPERGROUP, id: 1 }, "id does not apply to the topics method"],
  ])("refuses an argument of the other method %j", async (args, message) => {
    fillSampleChats(t)
    const error = await t.failure(args)
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(message)
  })

  test("takes the arguments of its own method, and account for all", async () => {
    fillSampleChats(t)
    const list = { method: "list", account: "default", query: "a", unread: true, last: true, refresh: false, limit: 5 }
    expect((await t.read(list)).chats).toBeDefined()
    const view = { method: "view", account: "default", chat: USER, after: "2026-01-01", before: "2999-01-01", limit: 5 }
    expect((await t.read(view)).messages).toBeDefined()
    t.follow({ id: SUPERGROUP, kind: "supergroup", name: "Dev Forum", username: null, forum: true })
    const topics = { method: "topics", account: "default", chat: SUPERGROUP, limit: 5 }
    await t.serve({ topics: () => ({ topics: [] }) })
    expect((await t.read(topics)).topics).toEqual([])
    const search = {
      method: "search",
      account: "default",
      query: "hello",
      chat: USER,
      after: "1969-01-01",
      before: "2020-01-01",
      limit: 5,
    }
    expect((await t.read(search)).messages).toHaveLength(1)
    const around = { method: "around", account: "default", chat: USER, id: 1, before_count: 1, after_count: 1 }
    expect((await t.read(around)).anchor).toBe(1)
  })

  test.each([
    {},
    { method: "send" },
    { method: "search" },
    { method: "around" },
    { method: "list", extra: 1 },
    { method: "list", unread: "yes" },
    { method: "list", limit: "5" },
    { method: "view", chat: 5 },
    { method: "view", chat: USER, topic: 0 },
    { method: "view", chat: USER, topic: 1.5 },
    { method: "view", chat: USER, topic: "1" },
    { method: "list", refresh: "yes" },
  ])("refuses invalid arguments %j", async (args) => {
    expect((await t.failure(args)).code).toBe("invalid_argument")
  })
})

describe("chat read: accounts and the mirror", () => {
  test("account names the label whose mirror is read", async () => {
    fillSampleChats(t)
    expect((await t.read({ method: "list", account: "default" })).chats).toHaveLength(5)
    expect((await t.failure({ method: "list", account: "Bad/Label" })).code).toBe("invalid_argument")
    expect((await t.failure({ method: "list", account: "other" })).code).toBe("not_found")
  })

  test("several labels need account, and the error lists them", async () => {
    mkdirSync(labelPaths(t.stateDir, "work").dir)
    const error = await t.failure({ method: "list" })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("default, work")
  })

  test("no account, a label without a mirror and a missing state directory are refused", async () => {
    const stateDir = makeTempDir()
    try {
      const call = (args: unknown) => invoke(telegramChatRead, args, { cwd: stateDir, stateDir })
      await expect(call({ method: "list" })).rejects.toMatchObject({ code: "not_found" })
      mkdirSync(labelPaths(stateDir, "default").dir)
      await expect(call({ method: "list" })).rejects.toMatchObject({ code: "not_found" })
      expect(existsSync(labelPaths(stateDir, "default").mirror)).toBe(false)
      await expect(invoke(telegramChatRead, { method: "list" }, { cwd: stateDir })).rejects.toMatchObject({
        code: "internal_error",
      })
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test("a mirror of another version is refused", async () => {
    t.mirror.exec(`PRAGMA user_version = ${MIRROR_VERSION + 1}`)
    const error = await t.failure({ method: "list" })
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("newer version")
  })

  test("a mirror that was never set up is not found", async () => {
    const paths = labelPaths(t.stateDir, "fresh")
    mkdirSync(paths.dir)
    const fresh = openMirrorForWrite(paths.mirror)
    fresh.exec("PRAGMA user_version = 0")
    fresh.close()
    expect((await t.failure({ method: "list", account: "fresh" })).code).toBe("not_found")
  })

  test("reading leaves the mirror's mtime and size unchanged, with no WAL left behind", async () => {
    fillSampleChats(t)
    t.closeMirror()
    const path = labelPaths(t.stateDir, "default").mirror
    expect(existsSync(`${path}-wal`)).toBe(false)
    const before = statSync(path)
    await t.read({ method: "list", last: true, unread: true, query: "ali" })
    await t.read({ method: "view", chat: USER })
    await t.failure({ method: "view", chat: GROUP, cursor: "garbage" })
    const after = statSync(path)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.size).toBe(before.size)
    expect(existsSync(`${path}-wal`)).toBe(false)
  })

  test("a result never carries the state directory", async () => {
    fillSampleChats(t)
    const json = JSON.stringify([
      await t.read({ method: "list", last: true }),
      await t.read({ method: "view", chat: USER }),
    ])
    expect(json).not.toContain(t.stateDir)
  })
})
