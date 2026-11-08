import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import type { DownloadResult } from "../telegram/service-requests"
import { createSaveFixture, saveArgs, type SaveFixture } from "./save.testing"

let t: SaveFixture
let outside: string

beforeEach(() => {
  t = createSaveFixture()
  outside = join(t.downloadDir, "outside")
  mkdirSync(outside)
  writeFileSync(join(outside, "secret.txt"), "the keys")
  mkdirSync(t.paths.incoming, { recursive: true })
})
afterEach(() => t.close())

/** The service's answer that a file is at `path`, whatever is there. */
const answerWith = (path: string) => (): DownloadResult => ({
  saved: { path, name: "x.txt", type: null, kind: "document", size: 8 },
})

/** Asserts that the call fails as an internal_error that names no path, and saves nothing. */
async function expectRefused(path: string): Promise<void> {
  await t.serve(answerWith(path))
  const error = await t.failure(saveArgs())
  expect(error.code).toBe("internal_error")
  expect(error.message).not.toContain(t.stateDir)
  expect(error.message).not.toContain(outside)
  expect(readdirSync(t.downloadDir)).toEqual(["outside"])
  expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("the keys")
}

describe("a path the service names that is not a plain file in its download folder", () => {
  test("a file outside incoming is refused, and left where it is", async () => {
    await expectRefused(join(outside, "secret.txt"))
    expect(readdirSync(outside)).toEqual(["secret.txt"])
  })

  test("a file directly in incoming, not in a folder of its own, is refused and kept", async () => {
    const path = join(t.paths.incoming, "loose")
    writeFileSync(path, "loose")
    await expectRefused(path)
    expect(existsSync(path)).toBe(true)
  })

  test("a link to a file elsewhere is not followed; the folder with the link is removed", async () => {
    const folder = join(t.paths.incoming, "linked")
    mkdirSync(folder)
    symlinkSync(join(outside, "secret.txt"), join(folder, "file"))
    await expectRefused(join(folder, "file"))
    expect(t.incomingNames()).toEqual([])
  })

  test("a link to a file inside incoming is a link all the same", async () => {
    const folder = join(t.paths.incoming, "linked")
    mkdirSync(folder)
    writeFileSync(join(folder, "real"), "real")
    symlinkSync(join(folder, "real"), join(folder, "file"))
    await expectRefused(join(folder, "file"))
    expect(t.incomingNames()).toEqual([])
  })

  test("a folder that is a link leading out of incoming is refused; only the link is removed", async () => {
    symlinkSync(outside, join(t.paths.incoming, "sneaky"))
    await expectRefused(join(t.paths.incoming, "sneaky", "secret.txt"))
    expect(t.incomingNames()).toEqual([])
    expect(readdirSync(outside)).toEqual(["secret.txt"])
  })

  test("a path with .. that leaves incoming is refused, and removes nothing outside it", async () => {
    const folder = join(t.paths.incoming, "folder")
    mkdirSync(folder)
    await expectRefused(`${folder}/${relative(folder, join(outside, "secret.txt"))}`)
    expect(t.incomingNames()).toEqual(["folder"])
  })

  test("a folder, a missing file and a relative path are refused", async () => {
    mkdirSync(join(t.paths.incoming, "folder", "file"), { recursive: true })
    await expectRefused(join(t.paths.incoming, "folder", "file"))
    await expectRefused(join(t.paths.incoming, "folder", "missing"))
    await expectRefused("incoming/folder/file")
  })

  test("a folder of another download in progress is left alone", async () => {
    const other = join(t.paths.incoming, "other")
    mkdirSync(other)
    writeFileSync(join(other, "file"), "in progress")
    await t.serveFile("mine")
    await t.save(saveArgs())
    expect(t.incomingNames()).toEqual(["other"])
    expect(readFileSync(join(other, "file"), "utf8")).toBe("in progress")
  })
})
