import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { symlinkSync } from "node:fs"
import { join } from "node:path"
import type { ServiceCalls } from "../../chat/read.testing"
import { SUPERGROUP, USER } from "../../telegram/mirror.testing"
import { writeTargets } from "../../targets"
import { createFileSendFixture, type FileSendFixture } from "./tool.testing"
import { telegramFileSend } from "./tool"

let t: FileSendFixture
let calls: ServiceCalls

beforeEach(async () => {
  t = createFileSendFixture()
  calls = (await t.serveFiles()).calls
})

afterEach(async () => {
  await t.close()
})

describe("file send: the arguments are checked before any request", () => {
  test.each([
    ["an unknown argument", { extra: 1 }],
    ["text instead of a caption", { text: "hello" }],
    ["an unknown key of a file", { files: [{ path: "a.txt", name: "b" }] }],
    ["a file without a path", { files: [{}] }],
    ["an empty path", { files: [{ path: "" }] }],
    ["files as text", { files: "a.txt" }],
    ["a caption that is not text", { caption: 5 }],
    ["a topic of 0", { topic: 0 }],
    ["a topic as text", { topic: "3" }],
    ["a reply of -4", { reply_to: -4 }],
    ["a reply as text", { reply_to: "5" }],
  ])("%s is invalid_argument", async (_what, extra) => {
    const error = await t.filesFailure({ files: [{ path: t.write("a.txt") }], ...extra })
    expect(error).toMatchObject({ code: "invalid_argument" })
    expect(calls).toHaveLength(0)
  })

  test.each([
    ["a name", "Alice Example"],
    ["a username", "@alice_example"],
    ["a phone number", "+15550100"],
    ["an empty id", ""],
  ])("chat as %s, before any file is read", async (_what, chat) => {
    const error = await t.filesFailure({ chat, files: [{ path: "missing.txt" }] })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("chat must be a chat id")
    expect(calls).toHaveLength(0)
  })

  test("an unknown account is not_found, before any file is read", async () => {
    const error = await t.filesFailure({ account: "other", files: [{ path: "missing.txt" }] })
    expect(error).toMatchObject({ code: "not_found" })
  })

  test("a chat the service does not list is its own refusal, passed through", async () => {
    expect(await t.sendFiles({ chat: SUPERGROUP, files: [{ path: t.write("a.txt") }] })).toMatchObject({
      chat: SUPERGROUP,
    })
  })
})

describe("file send: targets", () => {
  const targets = (args: Record<string, unknown>, ctx: Record<string, unknown> = {}) =>
    writeTargets(telegramFileSend, { chat: USER, ...args }, t.context(ctx))

  test("name the chat with its label and each file by real path", async () => {
    const real = t.write("real/a.txt")
    symlinkSync(real, join(t.work, "alias.txt"))
    expect(await targets({ files: [{ path: "alias.txt" }, { path: real }] })).toEqual([`default/${USER}`, real].sort())
  })

  test("name a file that does not resolve by its path made absolute against the working directory", async () => {
    expect(await targets({ files: [{ path: "sub/../missing.txt" }] })).toEqual(
      [`default/${USER}`, join(t.work, "missing.txt")].sort(),
    )
  })

  test("are any for the chat when the label or the chat cannot be told, and still name the files", async () => {
    const path = t.write("a.txt")
    expect(await targets({ account: "nobody", files: [{ path }] })).toEqual([path, "*"])
    expect(await targets({ chat: "Alice Example", files: [{ path }] })).toEqual([path, "*"])
    expect(await targets({ files: [{ path }] }, { stateDir: undefined })).toEqual([path, "*"])
  })

  test("are any for a file name that holds a wildcard", async () => {
    expect(await targets({ files: [{ path: "dir/*.txt" }] })).toEqual([`default/${USER}`, "*"])
  })

  test("are any for arguments the schema refuses", async () => {
    expect(await targets({ files: [] })).toEqual(["*"])
  })

  test("write nothing: no outbox is made", async () => {
    await targets({ files: [{ path: t.write("a.txt") }] })
    expect(t.outboxEntries()).toEqual([])
  })
})
