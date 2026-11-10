import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ServiceCalls } from "../chat/read.testing"
import { ToolError } from "../errors"
import { OTHER_USER, SUPERGROUP, USER } from "../telegram/mirror.testing"
import { REACTION_MAX_UNITS } from "../telegram/service-requests"
import { annotations, invoke, toolMeta } from "../tool"
import { DOWNLOAD_CONTEXT } from "../tool.testing"
import { createActionFixture, REACTED, THEIR_ID, THUMBS_UP, type ActionFixture } from "./action.testing"
import { telegramMessageReact } from "./react"

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

describe("react: the tool", () => {
  test("is an overwrite of the actions toolset", () => {
    expect(telegramMessageReact).toMatchObject({
      id: "telegram_message_react",
      toolset: "actions",
      class: "overwrite",
      intent: "About to change a reaction",
    })
    expect(annotations(telegramMessageReact)).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    })
    expect(toolMeta(telegramMessageReact)).toBeUndefined()
  })

  const targets = (args: object) => telegramMessageReact.targets?.({ id: THEIR_ID, ...args } as never, context())

  test("names the account, the chat and the message it writes to", async () => {
    expect(await targets({ chat: SUPERGROUP, id: 12 })).toEqual([`default/${SUPERGROUP}/12`])
    expect(await targets({ chat: OTHER_USER, account: "default" })).toEqual([`default/${OTHER_USER}/${THEIR_ID}`])
  })

  test("cannot tell what it writes to when the account or the chat is not usable", async () => {
    expect(await targets({ chat: USER, account: "elsewhere" })).toEqual(["*"])
    expect(await targets({ chat: "Alice Example" })).toEqual(["*"])
  })

  test("says what it does, which messages, what it refuses, what a result means and what `uncertain` asks", () => {
    const { description } = telegramMessageReact
    expect(description).toContain("one standard emoji")
    expect(description).toContain("removes the user's own reaction")
    expect(description).toContain("replaces any earlier one")
    expect(description).toContain("anyone's message")
    expect(description).toContain("`telegram_chat_read`")
    expect(description).toContain(`at most ${REACTION_MAX_UNITS} characters`)
    expect(description).toContain("Custom emoji reactions need Premium and paid reactions spend Stars")
    expect(description).toContain("sync service running")
    expect(description).toContain("`actions` toolset")
    expect(description).toContain("`already`")
    expect(description).toContain("`uncertain`")
    expect(description).toContain("never ask for it again without the user checking")
  })
})

describe("react: the arguments are checked before any request", () => {
  beforeEach(async () => {
    calls = await t.serveReact()
  })

  test.each([
    ["a name", { chat: "Alice Example" }],
    ["a phone number", { chat: "+15550100" }],
    ["a zero id", { id: 0 }],
    ["a decimal id", { id: 1.5 }],
    ["a text id", { id: "8" }],
    ["a non-text emoji", { emoji: 1 }],
    ["a non-boolean remove", { emoji: undefined, remove: "yes" }],
    ["an unknown argument", { silent: true }],
  ])("%s", async (_, args) => {
    expect((await t.reactFails(args)).code).toBe("invalid_argument")
    expect(calls).toHaveLength(0)
  })

  test.each([
    ["neither an emoji nor remove", { emoji: undefined }],
    ["remove false and no emoji", { emoji: undefined, remove: false }],
    ["both an emoji and remove", { remove: true }],
  ])("%s", async (_, args) => {
    expect(await t.reactFails(args)).toMatchObject({
      code: "invalid_argument",
      message: "Give exactly one of emoji and remove.",
    })
    expect(calls).toHaveLength(0)
  })

  test.each([
    ["an empty emoji", ""],
    ["a letter", "a"],
    ["a digit", "1"],
    ["blank space", " "],
    ["a word", "ok"],
    ["two emoji", "👍👎"],
    ["a text over the most units", "👍".repeat(REACTION_MAX_UNITS)],
  ])("%s is refused as an emoji", async (_, emoji) => {
    expect((await t.reactFails({ emoji })).code).toBe("invalid_argument")
    expect(calls).toHaveLength(0)
  })

  test("a refused emoji is never echoed", async () => {
    expect((await t.reactFails({ emoji: "Zq9secret" })).message).not.toContain("Zq9secret")
  })

  test("remove false with an emoji sets the emoji", async () => {
    await t.react({ remove: false })
    expect(calls).toEqual([{ method: "react", params: { chat: USER, id: THEIR_ID, emoji: THUMBS_UP } }])
  })
})

describe("react: the request", () => {
  test("sends the chat, the id and the emoji, as a write, and nothing else", async () => {
    calls = await t.serveReact()
    await t.react()
    expect(calls).toEqual([{ method: "react", params: { chat: USER, id: THEIR_ID, emoji: THUMBS_UP } }])
  })

  test("sends a removal as remove, with no emoji", async () => {
    calls = await t.serveReact(() => ({ id: THEIR_ID, removed: true }))
    await t.react({ emoji: undefined, remove: true })
    expect(calls).toEqual([{ method: "react", params: { chat: USER, id: THEIR_ID, remove: true } }])
  })

  test("sends an emoji with a skin tone and a joined sequence whole", async () => {
    calls = await t.serveReact()
    await t.react({ emoji: "👍🏽" })
    await t.react({ emoji: "👨‍👩‍👧" })
    expect(calls.map(({ params }) => (params as { emoji: string }).emoji)).toEqual(["👍🏽", "👨‍👩‍👧"])
  })

  test("takes the account's own service", async () => {
    calls = await t.serveReact()
    await t.react({ account: "default" })
    expect(calls).toHaveLength(1)
  })

  test("is a write: a reply lost after the request was written is uncertain, never a plain failure", async () => {
    await t.serveLost()
    const error = await t.reactFails()
    expect(error.code).toBe("uncertain")
    expect(error.message).toContain("react may have taken effect")
  })

  test("a signal already aborted sends nothing", async () => {
    calls = await t.serveReact()
    const controller = new AbortController()
    controller.abort()
    await expect(
      invoke(
        telegramMessageReact,
        { chat: USER, id: THEIR_ID, emoji: THUMBS_UP },
        { ...context(), signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(calls).toHaveLength(0)
  })
})

describe("react: the result", () => {
  test("a reaction set says it replaced any earlier one", async () => {
    await t.serveReact()
    expect(await t.react()).toEqual({
      chat: USER,
      id: THEIR_ID,
      emoji: THUMBS_UP,
      note: "Telegram set your reaction; it replaced any earlier one of yours.",
    })
  })

  test("a reaction removed says so, with no emoji", async () => {
    await t.serveReact(() => ({ id: THEIR_ID, removed: true }))
    expect(await t.react({ emoji: undefined, remove: true })).toEqual({
      chat: USER,
      id: THEIR_ID,
      removed: true,
      note: "Telegram removed your reaction.",
    })
  })

  test("a reaction that was already set says so", async () => {
    await t.serveReact(() => ({ ...REACTED, already: true }))
    expect(await t.react()).toEqual({
      chat: USER,
      id: THEIR_ID,
      emoji: THUMBS_UP,
      already: true,
      note: "Your reaction was already so; nothing changed.",
    })
  })

  test("a reaction that was already removed says so", async () => {
    await t.serveReact(() => ({ id: THEIR_ID, removed: true, already: true }))
    expect(await t.react({ emoji: undefined, remove: true })).toEqual({
      chat: USER,
      id: THEIR_ID,
      removed: true,
      already: true,
      note: "Your reaction was already so; nothing changed.",
    })
  })
})

describe("react: the service's answers pass through unchanged", () => {
  test.each([
    new ToolError("forbidden", "Telegram does not let this account react here; nothing was changed."),
    new ToolError("invalid_argument", "Telegram does not take this reaction here; nothing was changed."),
    new ToolError("not_found", "No message 8 in this chat; nothing was changed."),
    new ToolError("rate_limited", "Telegram asks to wait 30 seconds before the next reaction."),
    new ToolError("uncertain", "The reaction may have taken effect: check the chat in Telegram before asking again."),
    new ToolError("upstream_error", "The request was cancelled before Telegram answered."),
  ])("%p", async (refusal) => {
    await t.serveReact(() => {
      throw refusal
    })
    const failure = await t.reactFails()
    expect(failure).toMatchObject({ code: refusal.code, message: refusal.message })
    expect(failure.details).toBeUndefined()
  })

  test("the service not running is the client's error", async () => {
    const error = await t.reactFails()
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("sync service is not running")
  })
})
