import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ServiceCalls } from "../chat/read.testing"
import { ToolError } from "../errors"
import { CHANNEL, GROUP, SUPERGROUP, USER } from "../telegram/mirror.testing"
import { SYNC_LIST_LIMIT } from "../telegram/service-requests"
import { annotations } from "../tool"
import { telegramSyncRemove } from "./remove"
import { createSyncFixture, SUPERGROUP_B, type SyncFixture } from "./sync.testing"

let t: SyncFixture
let calls: ServiceCalls

beforeEach(() => {
  t = createSyncFixture()
})

afterEach(async () => {
  await t.stopServices()
  t.close()
})

const remove = (chats: unknown) => t.run(telegramSyncRemove, { chats })

describe("sync remove: the tool", () => {
  test("is an overwrite of the sync toolset, which asks like a destructive change", () => {
    expect(telegramSyncRemove).toMatchObject({ id: "telegram_sync_remove", toolset: "sync", class: "overwrite" })
    expect(annotations(telegramSyncRemove)).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    })
  })

  test("names the account it writes to", async () => {
    const ctx = { cwd: t.stateDir, stateDir: t.stateDir, ...DOWNLOAD_CONTEXT }
    expect(await telegramSyncRemove.targets?.({ chats: [SUPERGROUP] }, ctx)).toEqual(["default"])
  })

  test("says what it changes, what it needs and where the ids come from", () => {
    expect(telegramSyncRemove.description).toContain("deletes the ones it holds")
    expect(telegramSyncRemove.description).toContain("nothing changes at Telegram")
    expect(telegramSyncRemove.description).toContain("sync service running")
    expect(telegramSyncRemove.description).toContain(`at most ${SYNC_LIST_LIMIT}`)
    expect(telegramSyncRemove.description).toContain("telegram_sync_read")
    expect(telegramSyncRemove.description).toContain("`telegram_chat_read` method `list`")
  })
})

describe("sync remove: the request", () => {
  test("sends the chats and nothing else, and returns what the service answered", async () => {
    calls = await t.serve({ sync_remove: () => ({ removed: [SUPERGROUP], absent: [CHANNEL], size: 2 }) })
    const result = await remove([SUPERGROUP, CHANNEL])
    expect(calls).toEqual([{ method: "sync_remove", params: { chats: [SUPERGROUP, CHANNEL] } }])
    expect(result).toMatchObject({ removed: [SUPERGROUP], absent: [CHANNEL], size: 2, limit: SYNC_LIST_LIMIT })
    expect(result.note).toContain("lost their mirrored messages and earlier versions")
    expect(result.note).toContain("`view` and `around`")
  })

  test("leaves the mirror's list to the service", async () => {
    t.listed({ id: SUPERGROUP }, 1)
    calls = await t.serve({ sync_remove: () => ({ removed: [SUPERGROUP], absent: [], size: 0 }) })
    await remove([SUPERGROUP])
    expect(t.mirror.prepare("SELECT COUNT(*) AS n FROM sync_list").get()).toEqual({ n: 1 })
  })
})

describe("sync remove: arguments are refused before any request", () => {
  const tooMany = Array.from({ length: SYNC_LIST_LIMIT + 1 }, (_, index) => `-100${1000000001 + index}`)

  test.each([
    ["a name", ["Old Friends"], "chat must be a chat id"],
    ["a username", ["@old_friends"], "chat must be a chat id"],
    ["one bad id among good ones", [SUPERGROUP, "12a"], "chat must be a chat id"],
    ["a chat twice", [SUPERGROUP_B, SUPERGROUP_B], `chats names ${SUPERGROUP_B} twice`],
    ["no chats", [], "at least one chat id"],
    ["too many chats", tooMany, `at most ${SYNC_LIST_LIMIT}`],
  ])("%s", async (_, chats, message) => {
    calls = await t.serve({ sync_remove: () => ({ removed: [], absent: [], size: 0 }) })
    const error = await t.fail(telegramSyncRemove, { chats })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(message)
    expect(calls).toHaveLength(0)
  })

  test("unknown arguments", async () => {
    calls = await t.serve({ sync_remove: () => ({ removed: [], absent: [], size: 0 }) })
    const stray = await t.fail(telegramSyncRemove, { chats: [SUPERGROUP], purge: true })
    expect(stray.message).toContain("purge: unknown argument")
    expect(calls).toHaveLength(0)
  })
})

describe("sync remove: the service", () => {
  test("not running is the client's error", async () => {
    const error = await t.fail(telegramSyncRemove, { chats: [SUPERGROUP] })
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("sync service is not running")
  })

  test.each([
    new ToolError("not_found", "The chat list has no chat -1001000000001; refresh it, or check the id."),
    new ToolError("invalid_argument", `${GROUP} is always mirrored: the sync list is for supergroups and channels.`),
  ])("the service's error passes through: %p", async (refusal) => {
    await t.serve({
      sync_remove: () => {
        throw refusal
      },
    })
    const failure = await t.fail(telegramSyncRemove, { chats: [SUPERGROUP, USER] })
    expect(failure).toMatchObject({ code: refusal.code, message: refusal.message })
  })

  test("a lost reply is uncertain", async () => {
    await t.serveLost()
    expect((await t.fail(telegramSyncRemove, { chats: [SUPERGROUP] })).code).toBe("uncertain")
  })
})
import { DOWNLOAD_CONTEXT } from "../tool.testing"
