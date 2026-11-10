import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ServiceCalls } from "../chat/read.testing"
import { ToolError } from "../errors"
import { OTHER_USER, SUPERGROUP, USER } from "../telegram/mirror.testing"
import { annotations, invoke, toolMeta } from "../tool"
import { DOWNLOAD_CONTEXT } from "../tool.testing"
import { createActionFixture, MARKED_READ, THEIR_ID, type ActionFixture } from "./action.testing"
import { telegramChatMarkRead } from "./mark-read"

let t: ActionFixture
let calls: ServiceCalls

beforeEach(() => {
  t = createActionFixture()
  t.theirs()
})

afterEach(async () => {
  await t.stopServices()
  t.close()
})

const context = () => ({ cwd: t.stateDir, stateDir: t.stateDir, ...DOWNLOAD_CONTEXT })

describe("mark read: the tool", () => {
  test("is an idempotent change of the actions toolset", () => {
    expect(telegramChatMarkRead).toMatchObject({
      id: "telegram_chat_mark_read",
      toolset: "actions",
      class: "idempotent",
      intent: "About to mark messages read",
    })
    expect(annotations(telegramChatMarkRead)).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    })
    expect(toolMeta(telegramChatMarkRead)).toBeUndefined()
  })

  const targets = (args: object) => telegramChatMarkRead.targets?.({ up_to: THEIR_ID, ...args } as never, context())

  test("names the account and the chat it writes to, not a message", async () => {
    expect(await targets({ chat: SUPERGROUP, up_to: 12 })).toEqual([`default/${SUPERGROUP}`])
    expect(await targets({ chat: OTHER_USER, account: "default", topic: 5 })).toEqual([`default/${OTHER_USER}`])
  })

  test("cannot tell what it writes to when the account or the chat is not usable", async () => {
    expect(await targets({ chat: USER, account: "elsewhere" })).toEqual(["*"])
    expect(await targets({ chat: "Alice Example" })).toEqual(["*"])
  })

  test("says what it does, to whom it shows, when to use it, what a result means and what `uncertain` asks", () => {
    const { description } = telegramChatMarkRead
    expect(description).toContain("never further and never back")
    expect(description).toContain("`topic`")
    expect(description).toContain("Only when the user asks")
    expect(description).toContain("never marks anything read")
    expect(description).toContain("The senders see their messages as read")
    expect(description).toContain("`telegram_chat_read`")
    expect(description).toContain("sync service running")
    expect(description).toContain("`actions` toolset")
    expect(description).toContain("`already`")
    expect(description).toContain("`uncertain`")
    expect(description).toContain("never ask for it again without the user checking")
  })
})

describe("mark read: the arguments are checked before any request", () => {
  beforeEach(async () => {
    calls = await t.serveMarkRead()
  })

  test.each([
    ["a name", { chat: "Alice Example" }],
    ["no up_to", { up_to: undefined }],
    ["a zero up_to", { up_to: 0 }],
    ["a decimal up_to", { up_to: 1.5 }],
    ["a text up_to", { up_to: "8" }],
    ["a zero topic", { topic: 0 }],
    ["a text topic", { topic: "5" }],
    ["an unknown argument", { id: THEIR_ID }],
  ])("%s", async (_, args) => {
    expect((await t.markReadFails(args)).code).toBe("invalid_argument")
    expect(calls).toHaveLength(0)
  })
})

describe("mark read: the request", () => {
  test("sends the chat and the message alone for a whole chat, as a write", async () => {
    calls = await t.serveMarkRead()
    await t.markRead()
    expect(calls).toEqual([{ method: "mark_read", params: { chat: USER, up_to: THEIR_ID } }])
  })

  test("sends the topic when one is named", async () => {
    calls = await t.serveMarkRead()
    t.follow({ id: SUPERGROUP, kind: "supergroup", name: "Old Friends", username: null, forum: true })
    t.store({ chat: SUPERGROUP, id: 21 })
    await t.markRead({ chat: SUPERGROUP, up_to: 21, topic: 1 })
    expect(calls).toEqual([{ method: "mark_read", params: { chat: SUPERGROUP, up_to: 21, topic: 1 } }])
  })

  test("takes the account's own service", async () => {
    calls = await t.serveMarkRead()
    await t.markRead({ account: "default" })
    expect(calls).toHaveLength(1)
  })

  test("is a write: a reply lost after the request was written is uncertain, never a plain failure", async () => {
    await t.serveLost()
    const error = await t.markReadFails()
    expect(error.code).toBe("uncertain")
    expect(error.message).toContain("mark_read may have taken effect")
  })

  test("a signal already aborted sends nothing", async () => {
    calls = await t.serveMarkRead()
    const controller = new AbortController()
    controller.abort()
    await expect(
      invoke(telegramChatMarkRead, { chat: USER, up_to: THEIR_ID }, { ...context(), signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(calls).toHaveLength(0)
  })
})

describe("mark read: the result", () => {
  test("a chat marked read says who sees it", async () => {
    await t.serveMarkRead()
    expect(await t.markRead()).toEqual({
      chat: USER,
      up_to: THEIR_ID,
      note: "Telegram marked the messages read up to message 8: their senders can see they were read, and the user's other devices clear them.",
    })
  })

  test("a topic marked read names the topic", async () => {
    t.follow({ id: SUPERGROUP, kind: "supergroup", name: "Old Friends", username: null, forum: true })
    t.store({ chat: SUPERGROUP, id: 21, topic: 5 })
    await t.serveMarkRead((params) => params)
    expect(await t.markRead({ chat: SUPERGROUP, up_to: 21, topic: 5 })).toMatchObject({
      chat: SUPERGROUP,
      up_to: 21,
      topic: 5,
      note: expect.stringContaining("up to message 21"),
    })
  })

  test("a chat that was already read that far says so, and that nothing changed", async () => {
    await t.serveMarkRead(() => ({ ...MARKED_READ, already: true }))
    expect(await t.markRead()).toEqual({
      chat: USER,
      up_to: THEIR_ID,
      already: true,
      note: "The chat was already read up to here; nothing changed.",
    })
  })
})

describe("mark read: the service's answers pass through unchanged", () => {
  test.each([
    new ToolError(
      "forbidden",
      "Telegram does not let this account mark read here (CHAT_ADMIN_REQUIRED); nothing was marked read.",
    ),
    new ToolError("not_found", "Telegram has no such topic (TOPIC_ID_INVALID); nothing was marked read."),
    new ToolError(
      "rate_limited",
      "Telegram is limiting this account; the mark read did not happen. Try again in 30 seconds.",
    ),
    new ToolError(
      "uncertain",
      "The mark read may have gone through (Telegram answered TIMEOUT). Check the message in the chat before marking it again.",
    ),
    new ToolError("upstream_error", "The request was cancelled before Telegram answered."),
  ])("%p", async (refusal) => {
    await t.serveMarkRead(() => {
      throw refusal
    })
    const failure = await t.markReadFails()
    expect(failure).toMatchObject({ code: refusal.code, message: refusal.message })
    expect(failure.details).toBeUndefined()
  })

  test("the service not running is the client's error", async () => {
    const error = await t.markReadFails()
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("sync service is not running")
  })
})
