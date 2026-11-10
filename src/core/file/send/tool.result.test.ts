import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { ToolError } from "../../errors"
import { USER } from "../../telegram/mirror.testing"
import { formatLocalTime } from "../../time"
import { annotations } from "../../tool"
import { FILES_SENT_AT, createFileSendFixture, type FileSendFixture } from "./tool.testing"
import { telegramFileSend } from "./tool"

let t: FileSendFixture

beforeEach(() => {
  t = createFileSendFixture()
})

afterEach(async () => {
  await t.close()
})

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex")

describe("file send: the tool", () => {
  test("is an add of the files toolset, and so off by default", () => {
    expect(telegramFileSend).toMatchObject({ id: "telegram_file_send", toolset: "files", class: "add" })
    expect(annotations(telegramFileSend)).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    })
  })

  test("says what it needs, what a result means and what `uncertain` asks", () => {
    const { description } = telegramFileSend
    expect(description).toContain("`telegram_chat_read`")
    expect(description).toContain("1 to 10 files (100 MB together)")
    expect(description).toContain("working directory or the user's send directories")
    expect(description).toContain("Keys, secrets, programs and installers are refused")
    expect(description).toContain("checked entry by entry")
    expect(description).toContain("`sha256`")
    expect(description).toContain("sync service running")
    expect(description).toContain("`telegram_message_send`")
    expect(description).toContain("duplicate")
    expect(description).toContain("`uncertain`")
    expect(description).toContain("never send them again without the user checking")
  })
})

describe("file send: the result", () => {
  test("gives the files as sent, the messages' ids and the local time Telegram dated the first", async () => {
    const path = t.write("notes.txt", "hello\n")
    await t.serveFiles()
    expect(await t.sendFiles({ files: [{ path }] })).toEqual({
      chat: USER,
      messages: [{ id: 101, name: "notes.txt" }],
      time: formatLocalTime(FILES_SENT_AT),
      files: [{ path, name: "notes.txt", size: 6, sha256: sha256("hello\n") }],
      note: "Telegram accepted the files; that is not a read receipt.",
    })
  })

  test("leaves out what the service did not give", async () => {
    await t.serveFiles(() => ({}))
    const result = await t.sendFiles({ files: [{ path: t.write("a.txt") }] })
    expect(result).not.toHaveProperty("messages")
    expect(result).not.toHaveProperty("time")
  })

  test("names no outbox or state path, however the call ends", async () => {
    await t.serveFiles()
    const result = await t.sendFiles({ files: [{ path: t.write("a.txt") }] })
    expect(JSON.stringify(result)).not.toContain(t.stateDir)
    const error = await t.filesFailure({ files: [{ path: t.write("b.pem") }] })
    expect(error.message).not.toContain(t.stateDir)
  })

  test("a duplicate with every id says the earlier delivery went out once and not to send it again", async () => {
    const path = t.write("a.txt")
    await t.serveFiles(() => ({ messages: [{ id: 42, name: "a.txt" }], duplicate: true }))
    const result = await t.sendFiles({ files: [{ path }] })
    expect(result).toMatchObject({ chat: USER, messages: [{ id: 42, name: "a.txt" }], duplicate: true })
    expect(result).not.toHaveProperty("time")
    expect(result.note).toContain("earlier delivery of this same call had already gone out")
    expect(result.note).toContain("exist once")
    expect(result.note).toContain("Do not send them again")
    expect(result.note).not.toContain("known only")
  })

  test("a duplicate with some ids, or none, says which are known", async () => {
    const files = [{ path: t.write("a.txt", "1") }, { path: t.write("b.txt", "22") }]
    let answer: object = { messages: [{ id: 42, name: "a.txt" }], duplicate: true }
    await t.serveFiles(() => answer)
    const some = await t.sendFiles({ files })
    expect(some.messages).toEqual([{ id: 42, name: "a.txt" }])
    answer = { duplicate: true }
    const none = await t.sendFiles({ files })
    expect(none).not.toHaveProperty("messages")
    for (const result of [some, none]) {
      expect(result.duplicate).toBe(true)
      expect(result.note).toContain("Do not send them again")
      expect(result.note).toContain("known only for the files listed in `messages`")
      expect(result.note).toContain("`telegram_chat_read` shows the others")
    }
  })
})

describe("file send: the service's other answers pass through unchanged", () => {
  test.each([
    new ToolError("forbidden", "You cannot write in this chat; nothing was sent."),
    new ToolError("forbidden", "You are no longer in this chat; nothing was sent."),
    new ToolError("not_found", "No chat with this id in the chat list; refresh it, or check the id."),
    new ToolError("not_found", "No message 9 in this chat to reply to; nothing was sent."),
    new ToolError("rate_limited", "Telegram asks to wait 30 seconds before the next send."),
    new ToolError("invalid_argument", "This chat has no topics; nothing was sent."),
    new ToolError("upstream_error", "Telegram refused the request (MEDIA_EMPTY)."),
    new ToolError("upstream_error", "The upload stopped receiving bytes; nothing was sent."),
  ])("%p", async (refusal) => {
    await t.serveFiles(() => {
      throw refusal
    })
    const failure = await t.filesFailure({ files: [{ path: t.write("a.txt") }] })
    expect(failure).toMatchObject({ code: refusal.code, message: refusal.message })
    expect(failure.details).toBeUndefined()
    expect(t.outboxEntries()).toEqual([])
  })

  test("the service not running is the client's error", async () => {
    const error = await t.filesFailure({ files: [{ path: t.write("a.txt") }] })
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("sync service is not running")
    expect(t.outboxEntries()).toEqual([])
  })
})
