import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { USER } from "../telegram/mirror.testing"
import { BYTES_PER_MB } from "../telegram/service-requests"
import { annotations, type ToolContext } from "../tool"
import { writeTargets } from "../targets"
import { RESULT_NOTE } from "./constants"
import { telegramFileSave } from "./save"
import { MESSAGE_ID, createSaveFixture, saveArgs, type SaveFixture } from "./save.testing"

let t: SaveFixture

beforeEach(() => {
  t = createSaveFixture()
})
afterEach(() => t.close())

const sha256 = (content: string | Buffer) => createHash("sha256").update(content).digest("hex")
const mode = (path: string) => statSync(path).mode & 0o777

describe("the tool", () => {
  test("is in the files toolset and adds files, so it is never a read tool", () => {
    expect(telegramFileSave).toMatchObject({ id: "telegram_file_save", toolset: "files", class: "add" })
    expect(annotations(telegramFileSave)).toEqual({
      title: "Save a message's file",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    })
  })

  test("writes to the message's folder, which no call makes to find out", async () => {
    const ctx = { cwd: t.stateDir, stateDir: t.stateDir, downloadDir: t.downloadDir, downloadMaxMb: 100 }
    expect(await writeTargets(telegramFileSave, saveArgs(), ctx)).toEqual([t.folder])
    expect(await writeTargets(telegramFileSave, saveArgs({ unpack: true, account: "default" }), ctx)).toEqual([
      t.folder,
    ])
    expect(readdirSync(t.downloadDir)).toEqual([])
  })

  test("writes to * when the account, the chat, the id or a setting cannot be told", async () => {
    const ctx: ToolContext = { cwd: t.stateDir, stateDir: t.stateDir, downloadDir: t.downloadDir, downloadMaxMb: 1 }
    const any = ["*"]
    expect(await writeTargets(telegramFileSave, saveArgs(), { ...ctx, stateDir: undefined })).toEqual(any)
    expect(await writeTargets(telegramFileSave, saveArgs(), { ...ctx, downloadDir: "" })).toEqual(any)
    expect(await writeTargets(telegramFileSave, saveArgs({ account: "nobody" }), ctx)).toEqual(any)
    expect(await writeTargets(telegramFileSave, saveArgs({ chat: "alice" }), ctx)).toEqual(any)
    expect(await writeTargets(telegramFileSave, saveArgs({ id: 0 }), ctx)).toEqual(any)
    expect(await writeTargets(telegramFileSave, { chat: USER }, ctx)).toEqual(any)
    expect(
      await writeTargets(telegramFileSave, saveArgs(), { ...ctx, downloadDir: join(t.downloadDir, "d*") }),
    ).toEqual(any)
  })
})

describe("the arguments", () => {
  test.each([
    ["a chat that is a name", { chat: "alice" }],
    ["a chat that is a username", { chat: "@alice_example" }],
    ["a chat that is a phone number", { chat: "+15550100199" }],
    ["no chat", { chat: undefined }],
    ["an id of 0", { id: 0 }],
    ["a negative id", { id: -1 }],
    ["a fractional id", { id: 1.5 }],
    ["an id given as text", { id: "42" }],
    ["no id", { id: undefined }],
    ["an unpack that is no boolean", { unpack: "yes" }],
    ["an argument it does not take", { path: "/etc" }],
  ])("%s is invalid_argument before any request", async (_label, extra) => {
    const calls = await t.serveFile("x")
    expect((await t.failure(saveArgs(extra))).code).toBe("invalid_argument")
    expect(calls).toEqual([])
    expect(readdirSync(t.downloadDir)).toEqual([])
  })

  test("a chat the mirror does not list is not_found, before any request", async () => {
    const calls = await t.serveFile("x")
    const error = await t.failure(saveArgs({ chat: "-1001999999999" }))
    expect(error.code).toBe("not_found")
    expect(calls).toEqual([])
  })

  test("an account that is not logged in is not_found", async () => {
    expect((await t.failure(saveArgs({ account: "nobody" }))).code).toBe("not_found")
  })
})

describe("saving a message's file", () => {
  test("asks the service once, for this chat and message and the limit in bytes", async () => {
    const calls = await t.serveFile("x")
    await t.save(saveArgs(), { ctx: { downloadMaxMb: 3 } })
    expect(calls).toEqual([{ method: "download", params: { chat: USER, id: MESSAGE_ID, max_bytes: 3 * BYTES_PER_MB } }])
  })

  test("saves a plain file, private and not executable, with its content, size and SHA-256", async () => {
    await t.serveFile("hello, files")
    const result = await t.save(saveArgs())

    const path = join(t.folder, "notes.txt")
    expect(result).toEqual({
      chat: USER,
      id: MESSAGE_ID,
      folder: t.folder,
      files: [{ name: "notes.txt", path, type: "text/plain", size: 12, sha256: sha256("hello, files") }],
      note: RESULT_NOTE,
    })
    expect(RESULT_NOTE).toContain("never executable")
    expect(RESULT_NOTE).toContain("downloaded from Telegram")
    expect(readFileSync(path, "utf8")).toBe("hello, files")
    expect(mode(path)).toBe(0o600)
    for (const folder of [join(t.downloadDir, "default"), join(t.downloadDir, "default", USER), t.folder]) {
      expect(mode(folder)).toBe(0o700)
    }
    expect(readdirSync(t.folder)).toEqual(["notes.txt"])
  })

  test("removes the folder the service made, and leaves no partial file behind", async () => {
    await t.serveFile("data")
    await t.save(saveArgs())
    expect(t.incomingNames()).toEqual([])
    expect(readdirSync(t.folder).filter((name) => name.startsWith("."))).toEqual([])
  })

  test("never puts the state directory, the service's folder or the file's id in the result", async () => {
    await t.serveFile("data")
    const json = JSON.stringify(await t.save(saveArgs()))
    expect(json).not.toContain(t.stateDir)
    expect(json).not.toContain("download-1")
  })

  test("keeps only the first 100 characters of a declared type", async () => {
    await t.serveFile("x", { type: `application/x-${"long".repeat(100)}` })
    const result = await t.save(saveArgs())
    expect(result.files[0]!.type).toBe(`application/x-${"long".repeat(100)}`.slice(0, 100))
  })

  test("makes a download directory that does not exist yet, folder by folder, all private", async () => {
    await t.serveFile("x")
    const downloadDir = join(t.downloadDir, "new", "deeper")
    const result = await t.save(saveArgs(), { ctx: { downloadDir } })
    expect(result.folder).toBe(join(downloadDir, "default", USER, String(MESSAGE_ID)))
    expect(mode(join(t.downloadDir, "new"))).toBe(0o700)
    expect(mode(downloadDir)).toBe(0o700)
  })

  test("saves the files of two messages in folders of their own", async () => {
    await t.serveFile("one")
    const first = await t.save(saveArgs())
    const second = await t.save(saveArgs({ id: MESSAGE_ID + 1 }))
    expect(first.folder).not.toBe(second.folder)
    expect(readFileSync(join(second.folder, "notes.txt"), "utf8")).toBe("one")
    expect(second.folder.endsWith(`/${USER}/${MESSAGE_ID + 1}`)).toBe(true)
  })
})

describe("what is already in the folder", () => {
  /** Makes the message's folder, as an earlier call or the user would have. */
  const mkdirFolder = () => mkdirSync(t.folder, { recursive: true, mode: 0o700 })

  test("calling it again reuses the file that is saved", async () => {
    await t.serveFile("same bytes")
    const first = await t.save(saveArgs())
    const second = await t.save(saveArgs())
    expect(first.files[0]!.already_saved).toBeUndefined()
    expect(second.files).toEqual([{ ...first.files[0]!, already_saved: true }])
    expect(readdirSync(t.folder)).toEqual(["notes.txt"])
    expect(t.incomingNames()).toEqual([])
  })

  test("a different file under the name is never overwritten: the new one is numbered", async () => {
    await t.serveFile("from the sender")
    mkdirFolder()
    writeFileSync(join(t.folder, "notes.txt"), "the user's own", { mode: 0o644 })

    const result = await t.save(saveArgs())

    expect(result.files[0]!.name).toBe("notes (2).txt")
    expect(readFileSync(join(t.folder, "notes.txt"), "utf8")).toBe("the user's own")
    expect(mode(join(t.folder, "notes.txt"))).toBe(0o644)
    expect(readFileSync(join(t.folder, "notes (2).txt"), "utf8")).toBe("from the sender")
    expect((await t.save(saveArgs())).files[0]).toMatchObject({ name: "notes (2).txt", already_saved: true })
  })

  test.each([0o755, 0o644, 0o666, 0o400])(
    "the same bytes at mode %o are not a file this tool made: left untouched, a 0600 copy is numbered",
    async (existingMode) => {
      await t.serveFile("identical bytes")
      mkdirFolder()
      const existing = join(t.folder, "notes.txt")
      writeFileSync(existing, "identical bytes")
      chmodSync(existing, existingMode)

      const result = await t.save(saveArgs())

      expect(result.files[0]).toMatchObject({ name: "notes (2).txt" })
      expect(result.files[0]!.already_saved).toBeUndefined()
      expect(mode(existing)).toBe(existingMode)
      expect(mode(join(t.folder, "notes (2).txt"))).toBe(0o600)
    },
  )

  test("a file with the same size but other bytes is not taken for the saved one", async () => {
    await t.serveFile("aaaa")
    mkdirFolder()
    writeFileSync(join(t.folder, "notes.txt"), "bbbb", { mode: 0o600 })
    expect((await t.save(saveArgs())).files[0]!.name).toBe("notes (2).txt")
  })
})
