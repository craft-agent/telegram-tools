import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ServiceCalls } from "../chat/read.testing"
import { ToolError } from "../errors"
import { GROUP, OTHER_USER, SUPERGROUP, USER } from "../telegram/mirror.testing"
import { annotations, invoke, toolMeta } from "../tool"
import { DOWNLOAD_CONTEXT } from "../tool.testing"
import { createActionFixture, PINNED, THEIR_ID, type ActionFixture } from "./action.testing"
import { telegramMessagePin } from "./pin"

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
const UNPINNED = { id: THEIR_ID, pinned: false }

/** Follows the group `GROUP` and stores a message of its in, `THEIR_ID`. */
function inGroup(): void {
  t.follow({ id: GROUP, kind: "group", name: "Team Chat", username: null })
  t.store({ chat: GROUP, id: THEIR_ID, body: "hello team" })
}

describe("pin: the tool", () => {
  test("is an overwrite of the actions toolset", () => {
    expect(telegramMessagePin).toMatchObject({
      id: "telegram_message_pin",
      toolset: "actions",
      class: "overwrite",
      intent: "About to pin or unpin a message",
    })
    expect(annotations(telegramMessagePin)).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    })
    expect(toolMeta(telegramMessagePin)).toBeUndefined()
  })

  const targets = (args: object) => telegramMessagePin.targets?.({ id: THEIR_ID, ...args } as never, context())

  test("names the account, the chat and the message it writes to", async () => {
    expect(await targets({ chat: SUPERGROUP, id: 12 })).toEqual([`default/${SUPERGROUP}/12`])
    expect(await targets({ chat: OTHER_USER, account: "default" })).toEqual([`default/${OTHER_USER}/${THEIR_ID}`])
  })

  test("cannot tell what it writes to when the account or the chat is not usable", async () => {
    expect(await targets({ chat: USER, account: "elsewhere" })).toEqual(["*"])
    expect(await targets({ chat: "Alice Example" })).toEqual(["*"])
  })

  test("says what it does, which messages, the flags and their defaults, what a result means and what `uncertain` asks", () => {
    const { description } = telegramMessagePin
    expect(description).toContain("anyone's")
    expect(description).toContain("`unpin`")
    expect(description).toContain("silent by default")
    expect(description).toContain("`notify`")
    expect(description).toContain("`both_sides`")
    expect(description).toContain("for the user only by default")
    expect(description).toContain("`telegram_chat_read`")
    expect(description).toContain("sync service running")
    expect(description).toContain("`actions` toolset")
    expect(description).toContain("`already`")
    expect(description).toContain("`uncertain`")
    expect(description).toContain("never ask for it again without the user checking")
  })
})

describe("pin: the arguments are checked before any request", () => {
  beforeEach(async () => {
    calls = await t.servePin()
  })

  test.each([
    ["a name", { chat: "Alice Example" }],
    ["a zero id", { id: 0 }],
    ["a decimal id", { id: 1.5 }],
    ["a text id", { id: "8" }],
    ["a text flag", { notify: "yes" }],
    ["an unknown argument", { silent: true }],
  ])("%s", async (_, args) => {
    expect((await t.pinFails(args)).code).toBe("invalid_argument")
    expect(calls).toHaveLength(0)
  })

  test.each([
    ["notify with unpin", { unpin: true, notify: true }],
    ["both_sides with unpin", { unpin: true, both_sides: true }],
  ])("%s", async (_, args) => {
    expect(await t.pinFails(args)).toMatchObject({
      code: "invalid_argument",
      message: "notify and both_sides go with a pin, not an unpin.",
    })
    expect(calls).toHaveLength(0)
  })

  test("both_sides outside a chat with a person or a bot", async () => {
    inGroup()
    expect(await t.pinFails({ chat: GROUP, both_sides: true })).toMatchObject({
      code: "invalid_argument",
      message: "A pin can be made for both sides only in a chat with a person or a bot; nothing was pinned.",
    })
    expect(calls).toHaveLength(0)
  })

  test("flags that are off count as not given, even with unpin", async () => {
    await t.pin({ unpin: true, notify: false, both_sides: false })
    expect(calls).toEqual([{ method: "pin", params: { chat: USER, id: THEIR_ID, unpin: true } }])
  })
})

describe("pin: the request", () => {
  test("sends the chat and the id alone for a silent, one-sided pin, as a write", async () => {
    calls = await t.servePin()
    await t.pin()
    expect(calls).toEqual([{ method: "pin", params: { chat: USER, id: THEIR_ID } }])
  })

  test("sends only the flags that are on", async () => {
    calls = await t.servePin()
    await t.pin({ both_sides: true })
    inGroup()
    await t.pin({ chat: GROUP, notify: true })
    await t.pin({ unpin: true })
    expect(calls.map(({ params }) => params)).toEqual([
      { chat: USER, id: THEIR_ID, both_sides: true },
      { chat: GROUP, id: THEIR_ID, notify: true },
      { chat: USER, id: THEIR_ID, unpin: true },
    ])
  })

  test("takes the account's own service", async () => {
    calls = await t.servePin()
    await t.pin({ account: "default" })
    expect(calls).toHaveLength(1)
  })

  test("is a write: a reply lost after the request was written is uncertain, never a plain failure", async () => {
    await t.serveLost()
    const error = await t.pinFails()
    expect(error.code).toBe("uncertain")
    expect(error.message).toContain("pin may have taken effect")
  })

  test("a signal already aborted sends nothing", async () => {
    calls = await t.servePin()
    const controller = new AbortController()
    controller.abort()
    await expect(
      invoke(telegramMessagePin, { chat: USER, id: THEIR_ID }, { ...context(), signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(calls).toHaveLength(0)
  })
})

describe("pin: the result", () => {
  test("a silent, one-sided pin in a private chat says who sees it", async () => {
    await t.servePin()
    expect(await t.pin()).toEqual({
      chat: USER,
      id: THEIR_ID,
      pinned: true,
      note: "Telegram pinned the message, silently; only you see it pinned.",
    })
  })

  test("a pin for both sides in a private chat is silent, and not one-sided", async () => {
    await t.servePin()
    expect((await t.pin({ both_sides: true })).note).toBe("Telegram pinned the message, silently.")
  })

  test("a pin that notifies says no silence", async () => {
    inGroup()
    await t.servePin()
    expect((await t.pin({ chat: GROUP })).note).toBe("Telegram pinned the message, silently.")
    expect((await t.pin({ chat: GROUP, notify: true })).note).toBe("Telegram pinned the message.")
    expect((await t.pin({ notify: true })).note).toBe("Telegram pinned the message; only you see it pinned.")
  })

  test("an unpin says so", async () => {
    await t.servePin(() => UNPINNED)
    expect(await t.pin({ unpin: true })).toEqual({
      chat: USER,
      id: THEIR_ID,
      pinned: false,
      note: "Telegram unpinned the message.",
    })
  })

  test("a message that was already pinned says so", async () => {
    await t.servePin(() => ({ ...PINNED, already: true }))
    expect(await t.pin()).toEqual({
      chat: USER,
      id: THEIR_ID,
      pinned: true,
      already: true,
      note: "The message was already so; nothing changed.",
    })
  })

  test("a message that was already not pinned says so", async () => {
    await t.servePin(() => ({ ...UNPINNED, already: true }))
    expect(await t.pin({ unpin: true })).toEqual({
      chat: USER,
      id: THEIR_ID,
      pinned: false,
      already: true,
      note: "The message was already so; nothing changed.",
    })
  })
})

describe("pin: the service's answers pass through unchanged", () => {
  test.each([
    new ToolError("forbidden", "Telegram does not let this account pin messages here; nothing was pinned."),
    new ToolError("forbidden", "Telegram allows no more pinned messages in this chat; nothing was pinned."),
    new ToolError("not_found", "No message 8 in this chat; nothing was pinned."),
    new ToolError("rate_limited", "Telegram asks to wait 30 seconds before the next pin."),
    new ToolError("uncertain", "The pin may have taken effect: check the chat in Telegram before asking again."),
    new ToolError("upstream_error", "The request was cancelled before Telegram answered."),
  ])("%p", async (refusal) => {
    await t.servePin(() => {
      throw refusal
    })
    const failure = await t.pinFails()
    expect(failure).toMatchObject({ code: refusal.code, message: refusal.message })
    expect(failure.details).toBeUndefined()
  })

  test("the service not running is the client's error", async () => {
    const error = await t.pinFails()
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("sync service is not running")
  })
})
