import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { USER } from "../telegram/mirror.testing"
import { MESSAGE_ID, createSaveFixture, saveArgs, type SaveFixture } from "./save.testing"

let t: SaveFixture
let calls: Awaited<ReturnType<SaveFixture["serveFile"]>>

beforeEach(async () => {
  t = createSaveFixture()
  calls = await t.serveFile("payload", { name: "report.txt" })
})
afterEach(() => t.close())

describe("the download directory", () => {
  test("is required: an entry point that supplied none is an internal_error, before any request", async () => {
    const error = await t.failure(saveArgs(), { ctx: { downloadDir: undefined } })
    expect(error).toMatchObject({ code: "internal_error", message: expect.stringContaining("download directory") })
    expect(calls).toEqual([])
  })

  test("may not be inside the state directory, named by the setting, and the service is not asked", async () => {
    const downloadDir = join(t.stateDir, "downloads")
    const error = await t.failure(saveArgs(), { ctx: { downloadDir } })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("download_dir")
    expect(error.message).toContain("state directory")
    expect(existsSync(downloadDir)).toBe(false)
    expect(calls).toEqual([])
  })

  test("may not be the state directory, or the label's own folder or its incoming folder", async () => {
    for (const downloadDir of [t.stateDir, join(t.stateDir, "default"), t.paths.incoming]) {
      expect((await t.failure(saveArgs(), { ctx: { downloadDir } })).code).toBe("invalid_argument")
    }
    expect(calls).toEqual([])
  })

  test("may not reach the state directory through a link", async () => {
    const link = join(t.downloadDir, "link-to-state")
    symlinkSync(t.stateDir, link)
    const error = await t.failure(saveArgs(), { ctx: { downloadDir: join(link, "files") } })
    expect(error.code).toBe("invalid_argument")
    expect(readdirSync(t.stateDir)).not.toContain("files")
  })

  test("may not be inside the tools' own directory", async () => {
    const own = join(t.downloadDir, "installed")
    mkdirSync(own)
    const error = await t.failure(saveArgs(), { ctx: { ownDir: own, downloadDir: join(own, "dist", "files") } })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("download_dir")
    expect(existsSync(join(own, "dist"))).toBe(false)
  })

  test("may be a link to a folder elsewhere: its real path is what counts", async () => {
    const real = join(t.downloadDir, "real")
    mkdirSync(real)
    const link = join(t.downloadDir, "link")
    symlinkSync(real, link)
    const result = await t.save(saveArgs(), { ctx: { downloadDir: link } })
    expect(result.folder).toBe(join(real, "default", USER, String(MESSAGE_ID)))
    expect(readFileSync(join(result.folder, "report.txt"), "utf8")).toBe("payload")
  })

  test("a file where the download directory should be is invalid_argument", async () => {
    const file = join(t.downloadDir, "afile")
    writeFileSync(file, "x")
    expect((await t.failure(saveArgs(), { ctx: { downloadDir: join(file, "sub") } })).code).toBe("invalid_argument")
  })

  test("a relative download directory is an internal_error, since the entry point resolves it", async () => {
    expect((await t.failure(saveArgs(), { ctx: { downloadDir: "downloads" } })).code).toBe("internal_error")
  })
})

describe("links below the download directory are never followed", () => {
  const elsewhere = () => {
    const path = join(t.downloadDir, "elsewhere")
    mkdirSync(path)
    return path
  }

  test("a link where the label's folder belongs is refused, and nothing is written through it", async () => {
    const outside = elsewhere()
    symlinkSync(outside, join(t.downloadDir, "default"))
    const error = await t.failure(saveArgs())
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("a link")
    expect(readdirSync(outside)).toEqual([])
    expect(t.incomingNames()).toEqual([])
  })

  test("a link where the chat's or the message's folder belongs is refused", async () => {
    const outside = elsewhere()
    mkdirSync(join(t.downloadDir, "default"))
    symlinkSync(outside, join(t.downloadDir, "default", USER))
    expect((await t.failure(saveArgs())).code).toBe("invalid_argument")
    expect(readdirSync(outside)).toEqual([])
  })

  test("a link where the message's folder belongs is refused", async () => {
    const outside = elsewhere()
    mkdirSync(join(t.downloadDir, "default", USER), { recursive: true })
    symlinkSync(outside, t.folder)
    expect((await t.failure(saveArgs())).code).toBe("invalid_argument")
    expect(readdirSync(outside)).toEqual([])
  })

  test("a file where the message's folder belongs is refused", async () => {
    mkdirSync(join(t.downloadDir, "default", USER), { recursive: true })
    writeFileSync(t.folder, "not a folder")
    expect((await t.failure(saveArgs())).code).toBe("invalid_argument")
    expect(readFileSync(t.folder, "utf8")).toBe("not a folder")
    expect(t.incomingNames()).toEqual([])
  })

  test("a link planted at the file's name is not written through: the file is numbered", async () => {
    const victim = join(t.downloadDir, "victim.txt")
    writeFileSync(victim, "keep me")
    mkdirSync(t.folder, { recursive: true })
    symlinkSync(victim, join(t.folder, "report.txt"))

    const result = await t.save(saveArgs())

    expect(readFileSync(victim, "utf8")).toBe("keep me")
    expect(result.files[0]!.name).toBe("report (2).txt")
    expect(readFileSync(join(t.folder, "report (2).txt"), "utf8")).toBe("payload")
  })

  test("a dangling link at the file's name is not followed either", async () => {
    mkdirSync(t.folder, { recursive: true })
    const target = join(t.downloadDir, "not-there.txt")
    symlinkSync(target, join(t.folder, "report.txt"))
    const result = await t.save(saveArgs())
    expect(existsSync(target)).toBe(false)
    expect(result.files[0]!.name).toBe("report (2).txt")
  })

  test("an existing folder of the right kind is reused and keeps its mode", async () => {
    mkdirSync(t.folder, { recursive: true, mode: 0o750 })
    await t.save(saveArgs())
    expect(statSync(t.folder).mode & 0o777).toBe(0o750)
  })
})
