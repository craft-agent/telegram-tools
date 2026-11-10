import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ToolError } from "../../errors"
import { LEFTOVER_AGE_MS } from "./outbox"
import { createFileSendFixture, type FileSendFixture } from "./tool.testing"

let t: FileSendFixture

beforeEach(() => {
  t = createFileSendFixture()
})

afterEach(async () => {
  await t.close()
})

const HOUR = 60 * 60 * 1000
const callFolder = (seed: string) => seed.repeat(32).slice(0, 32)

/** Makes a folder in the outbox as an earlier call would have, last touched `hoursAgo` hours ago. */
function leftover(name: string, hoursAgo: number): string {
  const folder = join(t.paths.outbox, name)
  mkdirSync(join(folder, "0"), { recursive: true, mode: 0o700 })
  writeFileSync(join(folder, "0", "old.txt"), "left behind")
  const when = new Date(Date.now() - hoursAgo * HOUR)
  utimesSync(folder, when, when)
  return folder
}

describe("file send: the copies of a send", () => {
  test("are gone after a send that Telegram accepted", async () => {
    const { seen } = await t.serveFiles()
    await t.sendFiles({ files: [{ path: t.write("a.txt") }, { path: t.write("b.txt") }] })
    expect(seen).toHaveLength(2)
    for (const copy of seen) expect(existsSync(copy.path)).toBe(false)
    expect(t.outboxEntries()).toEqual([])
  })

  test("are gone after a send the service refused", async () => {
    const { seen } = await t.serveFiles(() => {
      throw new ToolError("forbidden", "You cannot write in this chat; nothing was sent.")
    })
    const error = await t.filesFailure({ files: [{ path: t.write("a.txt") }] })
    expect(error).toMatchObject({ code: "forbidden" })
    expect(existsSync(seen[0]!.path)).toBe(false)
    expect(t.outboxEntries()).toEqual([])
  })

  test("are gone after a send that is uncertain", async () => {
    await t.serveLost()
    const error = await t.filesFailure({ files: [{ path: t.write("a.txt") }] })
    expect(error).toMatchObject({ code: "uncertain" })
    expect(t.outboxEntries()).toEqual([])
  })

  test("are gone after a call that a check refused, when an earlier file was already copied", async () => {
    const { calls } = await t.serveFiles()
    const error = await t.filesFailure({
      files: [{ path: t.write("a.txt") }, { path: t.write("b.txt"), sha256: "0".repeat(64) }],
    })
    expect(error).toMatchObject({ code: "stale" })
    expect(calls).toHaveLength(0)
    expect(t.outboxEntries()).toEqual([])
  })

  test("are gone after a call that a content check refused on the copy, when an earlier file was already copied", async () => {
    const { calls } = await t.serveFiles()
    const error = await t.filesFailure({ files: [{ path: t.write("a.txt") }, { path: t.write("empty.txt", "") }] })
    expect(error).toMatchObject({ code: "forbidden" })
    expect(calls).toHaveLength(0)
    expect(t.outboxEntries()).toEqual([])
  })

  test("are still there while the service holds the request, and gone once the call ends", async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const { seen } = await t.serveFiles(async () => {
      await held
      return {}
    })
    const pending = t.sendFiles({ files: [{ path: t.write("a.txt") }] })
    while (seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(existsSync(seen[0]!.path)).toBe(true)
    expect(t.outboxEntries()).toHaveLength(1)
    release()
    await pending
    expect(t.outboxEntries()).toEqual([])
  })

  test("leave the outbox a private folder", async () => {
    await t.serveFiles()
    await t.sendFiles({ files: [{ path: t.write("a.txt") }] })
    expect(statSync(t.paths.outbox).mode & 0o777).toBe(0o700)
  })
})

describe("file send: leftovers of earlier calls", () => {
  beforeEach(() => mkdirSync(t.paths.outbox, { mode: 0o700 }))

  test("older than 24 hours are removed at the start of a call, newer ones are kept", async () => {
    const old = leftover(callFolder("a"), LEFTOVER_AGE_MS / HOUR + 1)
    const recent = leftover(callFolder("b"), LEFTOVER_AGE_MS / HOUR - 1)
    await t.serveFiles()
    await t.sendFiles({ files: [{ path: t.write("a.txt") }] })
    expect(existsSync(old)).toBe(false)
    expect(existsSync(recent)).toBe(true)
    expect(t.outboxEntries()).toEqual([callFolder("b")])
  })

  test("are swept even when the call then fails", async () => {
    const old = leftover(callFolder("c"), 48)
    await t.serveFiles()
    await t.filesFailure({ files: [{ path: "missing.txt" }] })
    expect(existsSync(old)).toBe(false)
  })

  test("only folders named as this tool names them, and only real ones, are touched", async () => {
    const other = leftover("not-a-call-folder", 48)
    const file = join(t.paths.outbox, callFolder("d"))
    writeFileSync(file, "a file")
    const elsewhere = mkdtempSync(join(tmpdir(), "outbox-target-"))
    writeFileSync(join(elsewhere, "keep.txt"), "keep")
    symlinkSync(elsewhere, join(t.paths.outbox, callFolder("e")))
    const when = new Date(Date.now() - 48 * HOUR)
    utimesSync(file, when, when)
    await t.serveFiles()
    await t.sendFiles({ files: [{ path: t.write("a.txt") }] })
    expect(existsSync(other)).toBe(true)
    expect(existsSync(file)).toBe(true)
    expect(existsSync(join(elsewhere, "keep.txt"))).toBe(true)
  })
})

describe("file send: the outbox", () => {
  test("is made when it is missing", async () => {
    await t.serveFiles()
    expect(existsSync(t.paths.outbox)).toBe(false)
    await t.sendFiles({ files: [{ path: t.write("a.txt") }] })
    expect(existsSync(t.paths.outbox)).toBe(true)
  })

  test("is refused when it is a link, and nothing is written through it or sent", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "outbox-target-"))
    symlinkSync(elsewhere, t.paths.outbox)
    const { calls } = await t.serveFiles()
    const error = await t.filesFailure({ files: [{ path: t.write("a.txt") }] })
    expect(error).toMatchObject({ code: "internal_error" })
    expect(error.message).not.toContain(t.stateDir)
    expect(calls).toHaveLength(0)
    expect(statSync(elsewhere).isDirectory()).toBe(true)
    expect(existsSync(join(elsewhere, "0"))).toBe(false)
  })
})
