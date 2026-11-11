import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ServiceCalls } from "../chat/read.testing"
import { ToolError } from "../errors"
import { recordDeleted } from "../telegram/mirror-rows"
import { NOW, OTHER_USER, SUPERGROUP, USER } from "../telegram/mirror.testing"
import { annotations, invoke, REQUIRES_USER_INTERACTION, toolMeta } from "../tool"
import { DOWNLOAD_CONTEXT } from "../tool.testing"
import { createActionFixture, DELETED, OWN_ID, type ActionFixture } from "./action.testing"
import { telegramMessageDelete } from "./delete"

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

describe("delete: the tool", () => {
  test("is administrative, in the actions toolset, and asks every time", () => {
    expect(telegramMessageDelete).toMatchObject({
      id: "telegram_message_delete",
      toolset: "actions",
      class: "administrative",
      intent: "About to delete a message",
    })
    expect(annotations(telegramMessageDelete)).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    })
    expect(toolMeta(telegramMessageDelete)).toEqual({ [REQUIRES_USER_INTERACTION]: true })
  })

  const targets = (args: object) => telegramMessageDelete.targets?.({ id: OWN_ID, ...args } as never, context())

  test("names the account, the chat and the message it writes to", async () => {
    expect(await targets({ chat: SUPERGROUP, id: 12 })).toEqual([`default/${SUPERGROUP}/12`])
    expect(await targets({ chat: OTHER_USER, account: "default" })).toEqual([`default/${OTHER_USER}/${OWN_ID}`])
  })

  test("cannot tell what it writes to when the account or the chat is not usable", async () => {
    expect(await targets({ chat: USER, account: "elsewhere" })).toEqual(["*"])
    expect(await targets({ chat: "Alice Example" })).toEqual(["*"])
  })

  test("says what it does, what it needs, what a result means and what `uncertain` asks", () => {
    const { description } = telegramMessageDelete
    expect(description).toContain("own messages")
    expect(description).toContain("for everyone")
    expect(description).toContain("cannot be undone")
    expect(description).toContain("`telegram_chat_read`")
    expect(description).toContain("sync service running")
    expect(description).toContain("`actions` toolset")
    expect(description).toContain("`already`")
    expect(description).toContain("`uncertain`")
    expect(description).toContain("never ask for it again without the user checking")
  })
})

describe("delete: the arguments and the mirror are checked before any request", () => {
  beforeEach(async () => {
    calls = await t.serveDelete()
  })

  test.each([
    ["a name", { chat: "Alice Example" }],
    ["a phone number", { chat: "+15550100" }],
    ["a zero id", { id: 0 }],
    ["a negative id", { id: -3 }],
    ["a decimal id", { id: 1.5 }],
    ["a text id", { id: "7" }],
    ["an unknown argument", { revoke: false }],
  ])("%s", async (_, args) => {
    expect((await t.removeFails(args)).code).toBe("invalid_argument")
    expect(calls).toHaveLength(0)
  })

  test("a chat the mirror lacks, and a message it lacks, are not found", async () => {
    expect((await t.removeFails({ chat: OTHER_USER })).code).toBe("not_found")
    expect(await t.removeFails({ id: 99 })).toMatchObject({
      code: "not_found",
      message: "No message 99 in this chat; nothing was deleted.",
    })
    expect(calls).toHaveLength(0)
  })

  test("another person's message is forbidden, in the service's words", async () => {
    t.store({ id: 8, body: "from Alice" })
    expect(await t.removeFails({ id: 8 })).toMatchObject({
      code: "forbidden",
      message: "Only your own messages can be deleted.",
    })
    expect(calls).toHaveLength(0)
  })

  test("a message in Saved Messages stored as not sent by the user is left to the service", async () => {
    t.follow({ id: OTHER_USER, kind: "self", name: "Me", username: null })
    t.store({ chat: OTHER_USER, id: 8, body: "a note" })
    await t.remove({ chat: OTHER_USER, id: 8 })
    expect(calls).toEqual([{ method: "delete", params: { chat: OTHER_USER, id: 8 } }])
  })

  test("a chat the user has left is forbidden", async () => {
    t.follow({ left: true })
    expect(await t.removeFails()).toMatchObject({
      code: "forbidden",
      message: "You are no longer in this chat; nothing was deleted.",
    })
    expect(calls).toHaveLength(0)
  })

  test("a message the mirror has as deleted is left to the service, which answers `already`", async () => {
    recordDeleted(t.mirror, USER, 99, NOW)
    await t.remove({ id: 99 })
    expect(calls).toEqual([{ method: "delete", params: { chat: USER, id: 99 } }])
  })
})

describe("delete: the request", () => {
  test("sends the chat and the id, as a write, and nothing else", async () => {
    calls = await t.serveDelete()
    await t.remove()
    expect(calls).toEqual([{ method: "delete", params: { chat: USER, id: OWN_ID } }])
  })

  test("takes the account's own service", async () => {
    calls = await t.serveDelete()
    await t.remove({ account: "default" })
    expect(calls).toHaveLength(1)
  })

  test("is a write: a reply lost after the request was written is uncertain, never a plain failure", async () => {
    await t.serveLost()
    const error = await t.removeFails()
    expect(error.code).toBe("uncertain")
    expect(error.message).toContain("delete may have taken effect")
  })

  test("a signal already aborted sends nothing", async () => {
    calls = await t.serveDelete()
    const controller = new AbortController()
    controller.abort()
    await expect(
      invoke(telegramMessageDelete, { chat: USER, id: OWN_ID }, { ...context(), signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(calls).toHaveLength(0)
  })
})

describe("delete: the result", () => {
  test("says the message is deleted for everyone", async () => {
    await t.serveDelete()
    expect(await t.remove()).toEqual({
      chat: USER,
      id: OWN_ID,
      deleted: true,
      note: "Telegram deleted the message for everyone.",
    })
  })

  test("a message that was already deleted says so, and is not a failure", async () => {
    await t.serveDelete(() => ({ ...DELETED, already: true }))
    expect(await t.remove()).toEqual({
      chat: USER,
      id: OWN_ID,
      deleted: true,
      already: true,
      note: "The message was already deleted.",
    })
  })
})

describe("delete: the service's answers pass through unchanged", () => {
  test.each([
    new ToolError("forbidden", "Telegram does not let this account delete this message; nothing was deleted."),
    new ToolError("not_found", "No message 7 in this chat; nothing was deleted."),
    new ToolError("rate_limited", "Telegram asks to wait 30 seconds before the next delete."),
    new ToolError("uncertain", "The delete may have taken effect: check the chat in Telegram before asking again."),
    new ToolError("upstream_error", "The request was cancelled before Telegram answered."),
  ])("%p", async (refusal) => {
    await t.serveDelete(() => {
      throw refusal
    })
    const failure = await t.removeFails()
    expect(failure).toMatchObject({ code: refusal.code, message: refusal.message })
    expect(failure.details).toBeUndefined()
  })

  test("the service not running is the client's error", async () => {
    const error = await t.removeFails()
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("sync service is not running")
  })
})

describe("delete: the tool's own question, where the entry point asks one", () => {
  const removeWith = (answer: boolean, asked: string[]) =>
    invoke(
      telegramMessageDelete,
      { chat: USER, id: OWN_ID },
      {
        ...context(),
        confirm: async ({ message }) => {
          asked.push(message)
          return answer
        },
      },
    )

  test("asks in plain words, by ids only, and deletes on an accept", async () => {
    calls = await t.serveDelete()
    const asked: string[] = []
    expect(await removeWith(true, asked)).toMatchObject({ deleted: true })
    expect(asked).toEqual([`Delete message ${OWN_ID} in chat ${USER} for everyone? It cannot be undone.`])
    expect(calls).toHaveLength(1)
  })

  test("anything but an accept is declined, with no request", async () => {
    calls = await t.serveDelete()
    const error = await removeWith(false, []).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: "declined" })
    expect(calls).toHaveLength(0)
  })
})
