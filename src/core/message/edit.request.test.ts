import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ServiceCalls } from "../chat/read.testing"
import { ToolError } from "../errors"
import { OTHER_USER, SUPERGROUP, USER } from "../telegram/mirror.testing"
import { CAPTION_MAX_UNITS, TEXT_MAX_UNITS } from "../telegram/service-requests"
import { formatLocalTime } from "../time"
import { annotations, invoke, toolMeta } from "../tool"
import { DOWNLOAD_CONTEXT } from "../tool.testing"
import { createActionFixture, EDITED, OWN_ID, type ActionFixture } from "./action.testing"
import { telegramMessageEdit } from "./edit"

let t: ActionFixture
let calls: ServiceCalls

beforeEach(() => {
  t = createActionFixture()
  t.own()
})

afterEach(async () => {
  await t.stopServices()
  t.close()
})

const context = () => ({ cwd: t.stateDir, stateDir: t.stateDir, ...DOWNLOAD_CONTEXT })

describe("edit: the tool", () => {
  test("is an overwrite of the actions toolset", () => {
    expect(telegramMessageEdit).toMatchObject({
      id: "telegram_message_edit",
      toolset: "actions",
      class: "overwrite",
      intent: "About to edit a message",
    })
    expect(annotations(telegramMessageEdit)).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    })
    expect(toolMeta(telegramMessageEdit)).toBeUndefined()
  })

  const targets = (args: object) =>
    telegramMessageEdit.targets?.({ id: OWN_ID, text: "new text", ...args } as never, context())

  test("names the account, the chat and the message it writes to", async () => {
    expect(await targets({ chat: SUPERGROUP, id: 12 })).toEqual([`default/${SUPERGROUP}/12`])
    expect(await targets({ chat: OTHER_USER, account: "default" })).toEqual([`default/${OTHER_USER}/${OWN_ID}`])
  })

  test("cannot tell what it writes to when the account or the chat is not usable", async () => {
    expect(await targets({ chat: USER, account: "elsewhere" })).toEqual(["*"])
    expect(await targets({ chat: "Alice Example" })).toEqual(["*"])
  })

  test("says what it does, what it needs, what a result means and what `uncertain` asks", () => {
    const { description } = telegramMessageEdit
    expect(description).toContain("own messages")
    expect(description).toContain("caption")
    expect(description).toContain("`telegram_chat_read`")
    expect(description).toContain(`at most ${TEXT_MAX_UNITS} characters (${CAPTION_MAX_UNITS} for a caption)`)
    expect(description).toContain("never read as Markdown or HTML")
    expect(description).toContain("time Telegram allows an edit")
    expect(description).toContain("sync service running")
    expect(description).toContain("`actions` toolset")
    expect(description).toContain("`already`")
    expect(description).toContain("`uncertain`")
    expect(description).toContain("never ask for it again without the user checking")
  })
})

describe("edit: the request", () => {
  test("sends the chat, the id and the trimmed text, as a write", async () => {
    calls = await t.serveEdit()
    await t.edit({ text: "  new text there \n" })
    expect(calls).toEqual([{ method: "edit", params: { chat: USER, id: OWN_ID, text: "new text there" } }])
  })

  test("sends the text as written: Markdown and HTML stay as they are", async () => {
    calls = await t.serveEdit()
    const text = "*bold* _it_ `code` <b>x</b> [a](https://example.test)"
    await t.edit({ text })
    expect((calls[0]?.params as { text: string }).text).toBe(text)
  })

  test("takes the account's own service", async () => {
    calls = await t.serveEdit()
    await t.edit({ account: "default" })
    expect(calls).toHaveLength(1)
  })

  test("is a write: a reply lost after the request was written is uncertain, never a plain failure", async () => {
    await t.serveLost()
    const error = await t.editFails()
    expect(error.code).toBe("uncertain")
    expect(error.message).toContain("edit may have taken effect")
  })

  test("a signal already aborted sends nothing", async () => {
    calls = await t.serveEdit()
    const controller = new AbortController()
    controller.abort()
    await expect(
      invoke(
        telegramMessageEdit,
        { chat: USER, id: OWN_ID, text: "new text" },
        { ...context(), signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(calls).toHaveLength(0)
  })
})

describe("edit: the result", () => {
  test("gives the id and the local time of the edit", async () => {
    await t.serveEdit()
    expect(await t.edit()).toEqual({
      chat: USER,
      id: OWN_ID,
      edited: formatLocalTime(EDITED.edited),
      note: "Telegram accepted the edit; the chat shows the new text, marked edited.",
    })
  })

  test("an edit that was already made says so, and not to edit again", async () => {
    await t.serveEdit(() => ({ id: OWN_ID, already: true }))
    const result = await t.edit()
    expect(result).toEqual({
      chat: USER,
      id: OWN_ID,
      already: true,
      note: "The message already had this text: an earlier delivery of this edit went through. Do not edit it again.",
    })
    expect(result).not.toHaveProperty("edited")
  })

  test("an edit already made keeps the time the service gave", async () => {
    await t.serveEdit(() => ({ ...EDITED, already: true }))
    expect(await t.edit()).toMatchObject({ already: true, edited: formatLocalTime(EDITED.edited) })
  })
})

describe("edit: the service's answers pass through unchanged", () => {
  test.each([
    new ToolError("forbidden", "Telegram no longer lets this message be edited; nothing was edited."),
    new ToolError("not_found", "No message 7 in this chat; nothing was edited."),
    new ToolError("rate_limited", "Telegram asks to wait 30 seconds before the next edit."),
    new ToolError("invalid_argument", "Telegram refused the text; nothing was edited."),
    new ToolError("uncertain", "The edit may have taken effect: check the chat in Telegram before asking again."),
    new ToolError("upstream_error", "The request was cancelled before Telegram answered."),
  ])("%p", async (refusal) => {
    await t.serveEdit(() => {
      throw refusal
    })
    const failure = await t.editFails()
    expect(failure).toMatchObject({ code: refusal.code, message: refusal.message })
    expect(failure.details).toBeUndefined()
  })

  test("the service not running is the client's error", async () => {
    const error = await t.editFails()
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("sync service is not running")
  })
})
