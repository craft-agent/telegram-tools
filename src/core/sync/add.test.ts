import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ToolError } from "../errors"
import { SYNC_LIST_LIMIT } from "../telegram/service-requests"
import { CHANNEL, GROUP, SUPERGROUP, USER } from "../telegram/mirror.testing"
import { annotations } from "../tool"
import { telegramSyncAdd } from "./add"
import { createSyncFixture, SUPERGROUP_B, type SyncFixture } from "./sync.testing"
import type { ServiceCalls } from "../chat/read.testing"

let t: SyncFixture
let calls: ServiceCalls

beforeEach(() => {
  t = createSyncFixture()
})

afterEach(async () => {
  await t.stopServices()
  t.close()
})

const add = (chats: unknown, extra: Record<string, unknown> = {}) => t.run(telegramSyncAdd, { chats, ...extra })

describe("sync add: the tool", () => {
  test("is an idempotent change of the sync toolset", () => {
    expect(telegramSyncAdd).toMatchObject({ id: "telegram_sync_add", toolset: "sync", class: "idempotent" })
    expect(annotations(telegramSyncAdd)).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    })
  })

  test("names the account it writes to", async () => {
    expect(
      await telegramSyncAdd.targets?.(
        { chats: [SUPERGROUP] },
        { cwd: t.stateDir, stateDir: t.stateDir, ...DOWNLOAD_CONTEXT },
      ),
    ).toEqual(["default"])
  })

  test("says what it changes, what it needs and where the ids come from", () => {
    expect(telegramSyncAdd.description).toContain("nothing changes at Telegram")
    expect(telegramSyncAdd.description).toContain("sync service running")
    expect(telegramSyncAdd.description).toContain(`at most ${SYNC_LIST_LIMIT}`)
    expect(telegramSyncAdd.description).toContain("telegram_sync_read")
    expect(telegramSyncAdd.description).toContain("`telegram_chat_read` method `list`")
  })
})

describe("sync add: the request", () => {
  test("sends the chats and nothing else, and returns what the service answered", async () => {
    calls = await t.serve({ sync_add: () => ({ added: [SUPERGROUP], listed: [CHANNEL], size: 3 }) })
    const result = await add([SUPERGROUP, CHANNEL])
    expect(calls).toEqual([{ method: "sync_add", params: { chats: [SUPERGROUP, CHANNEL] } }])
    expect(result).toMatchObject({ added: [SUPERGROUP], listed: [CHANNEL], size: 3, limit: SYNC_LIST_LIMIT })
    expect(result.note).toContain("newest 50 messages")
    expect(result.note).toContain("`telegram_chat_read` method `fetch`")
  })

  test("takes the account's own service", async () => {
    calls = await t.serve({ sync_add: () => ({ added: [SUPERGROUP], listed: [], size: 1 }) })
    await add([SUPERGROUP], { account: "default" })
    expect(calls).toHaveLength(1)
  })

  test("accepts as many chats as the list holds", async () => {
    const chats = Array.from({ length: SYNC_LIST_LIMIT }, (_, index) => `-100${1000000001 + index}`)
    calls = await t.serve({ sync_add: () => ({ added: chats, listed: [], size: chats.length }) })
    expect((await add(chats)).size).toBe(SYNC_LIST_LIMIT)
    expect(calls[0]?.params).toEqual({ chats })
  })

  test("leaves the mirror's list to the service", async () => {
    calls = await t.serve({ sync_add: () => ({ added: [SUPERGROUP], listed: [], size: 1 }) })
    await add([SUPERGROUP])
    expect(t.mirror.prepare("SELECT COUNT(*) AS n FROM sync_list").get()).toEqual({ n: 0 })
  })
})

describe("sync add: arguments are refused before any request", () => {
  const tooMany = Array.from({ length: SYNC_LIST_LIMIT + 1 }, (_, index) => `-100${1000000001 + index}`)

  test.each([
    ["a name", ["Old Friends"], "chat must be a chat id"],
    ["a username", ["@old_friends"], "chat must be a chat id"],
    ["a phone number", ["+15550100"], "chat must be a chat id"],
    ["an empty id", [""], "chat must be a chat id"],
    ["one bad id among good ones", [SUPERGROUP, "12a"], "chat must be a chat id"],
    ["a chat twice", [SUPERGROUP, CHANNEL, SUPERGROUP], `chats names ${SUPERGROUP} twice`],
    ["no chats", [], "at least one chat id"],
    ["too many chats", tooMany, `at most ${SYNC_LIST_LIMIT}`],
    ["a number as a chat", [123], "chats.0"],
    ["a single id, not a list", SUPERGROUP, "chats"],
  ])("%s", async (_, chats, message) => {
    calls = await t.serve({ sync_add: () => ({ added: [], listed: [], size: 0 }) })
    const error = await t.fail(telegramSyncAdd, { chats })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(message)
    expect(calls).toHaveLength(0)
  })

  test("missing chats and unknown arguments", async () => {
    calls = await t.serve({ sync_add: () => ({ added: [], listed: [], size: 0 }) })
    expect((await t.fail(telegramSyncAdd, {})).code).toBe("invalid_argument")
    const stray = await t.fail(telegramSyncAdd, { chats: [SUPERGROUP], channel: CHANNEL })
    expect(stray.message).toContain("channel: unknown argument")
    expect(calls).toHaveLength(0)
  })
})

describe("sync add: the service", () => {
  test("not running is the client's error", async () => {
    const error = await t.fail(telegramSyncAdd, { chats: [SUPERGROUP] })
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("sync service is not running")
  })

  test.each([
    new ToolError("not_found", "The chat list has no chat -1001000000001; refresh it, or check the id."),
    new ToolError("invalid_argument", `${GROUP} is always mirrored: the sync list is for supergroups and channels.`),
    new ToolError("invalid_argument", "Channels are off; turn the channels setting on to list them."),
    new ToolError("invalid_argument", `The sync list holds at most ${SYNC_LIST_LIMIT} chats; remove some first.`),
  ])("the service's error passes through: %p", async (refusal) => {
    await t.serve({
      sync_add: () => {
        throw refusal
      },
    })
    const failure = await t.fail(telegramSyncAdd, { chats: [SUPERGROUP, USER] })
    expect(failure).toMatchObject({ code: refusal.code, message: refusal.message })
  })

  test("a lost reply is uncertain, and says to check before trying again", async () => {
    await t.serveLost()
    const error = await t.fail(telegramSyncAdd, { chats: [SUPERGROUP, SUPERGROUP_B] })
    expect(error.code).toBe("uncertain")
    expect(error.message).toContain("sync_add")
  })

  test("a service that failed on it is uncertain too", async () => {
    await t.serve({
      sync_add: () => {
        throw new Error("boom")
      },
    })
    expect((await t.fail(telegramSyncAdd, { chats: [SUPERGROUP] })).code).toBe("uncertain")
  })
})
import { DOWNLOAD_CONTEXT } from "../tool.testing"
