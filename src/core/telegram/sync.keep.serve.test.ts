import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fakeViewOncePhotoMedia } from "./fake-telegram-media.testing"
import { FAKE_DATE } from "./fake-telegram.testing"
import type { DownloadResult, SavedFile } from "./service-requests"
import { failureOf } from "./service.testing"
import { CHAT, download, fileMedia, incomingFolders, mediaMessage } from "./sync-download.testing"
import { CHUNK, keptFolder, modeOf, writeKept } from "./sync-keep.testing"
import { KEPT, seedListedChats } from "./sync-requests.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture
let outside: string

beforeEach(async () => {
  fixture = syncFixture()
  fixture.client.setDownload([CHUNK])
  seedListedChats(fixture)
  outside = mkdtempSync(join(tmpdir(), "tg-outside-"))
  writeFileSync(join(outside, "file"), "secret")
  writeFileSync(join(outside, "meta.json"), JSON.stringify({ name: "s.txt", type: null, kind: "document", size: 6 }))
  await fixture.running()
})

afterEach(() => {
  rmSync(outside, { recursive: true, force: true })
  return fixture.close()
})

const MAX = 1000
const calls = (method: "getMessages" | "downloadAsIterable") => fixture.client.argsOf(method).length

function savedOf(result: DownloadResult): SavedFile {
  if (!("saved" in result)) throw new Error(`expected a saved file, got ${JSON.stringify(result)}`)
  return result.saved
}

/** What a kept photo declares. */
const PHOTO = { name: null, type: null, kind: "photo" } as const

describe("a download of a message whose file was kept", () => {
  test("is a copy in a folder of incoming/, served without asking Telegram", async () => {
    writeKept(fixture, KEPT, 1, CHUNK, PHOTO)

    const saved = savedOf(await download(fixture, 1, MAX, KEPT))

    expect(saved).toEqual({ path: saved.path, name: null, type: null, size: 3, kind: "photo", kept: true })
    const folder = dirname(saved.path)
    expect(dirname(folder)).toBe(fixture.paths.incoming)
    expect(basename(folder)).toMatch(/^[0-9a-f]{32}$/)
    expect(basename(saved.path)).toBe("file")
    expect(modeOf(folder)).toBe(0o700)
    expect(modeOf(saved.path)).toBe(0o600)
    expect([...readFileSync(saved.path)]).toEqual([...CHUNK])
    expect(calls("getMessages")).toBe(0)
    expect(calls("downloadAsIterable")).toBe(0)
    expect([...readFileSync(join(keptFolder(fixture, KEPT, 1), "file"))]).toEqual([...CHUNK])
  })

  test("gives each call a copy of its own and says when the message disappears", async () => {
    writeKept(fixture, KEPT, 1, CHUNK, { disappears_at: (FAKE_DATE + 3600) * 1000 })

    const first = savedOf(await download(fixture, 1, MAX, KEPT))
    const second = savedOf(await download(fixture, 1, MAX, KEPT))

    expect(first).toMatchObject({
      name: "a.txt",
      type: "text/plain",
      kept: true,
      disappears_at: (FAKE_DATE + 3600) * 1000,
    })
    expect(dirname(first.path)).not.toBe(dirname(second.path))
    expect(incomingFolders(fixture)).toHaveLength(2)
  })

  test("is refused as a download is when it is over max_bytes, and leaves no folder", async () => {
    writeKept(fixture, KEPT, 1, CHUNK, PHOTO)

    expect(await download(fixture, 1, 2, KEPT)).toEqual({
      refused: { name: null, type: null, size: 3, kind: "photo", reason: "it is 1 MB, over the 1 MB download limit" },
    })
    expect(incomingFolders(fixture)).toEqual([])
    expect(savedOf(await download(fixture, 1, 3, KEPT)).size).toBe(3)
  })

  test("is served for a view-once file Telegram would not give, instead of `forbidden`", async () => {
    writeKept(fixture, CHAT, 1)
    fixture.client.setHistory(CHAT, mediaMessage(1, fakeViewOncePhotoMedia()))

    expect(savedOf(await download(fixture, 1, MAX))).toMatchObject({ name: "a.txt", kept: true })
    expect(calls("getMessages")).toBe(0)
  })
})

describe("a download with no usable kept copy", () => {
  beforeEach(() => fixture.client.setHistory(CHAT, mediaMessage(1, fileMedia("a.txt", "text/plain", 3))))

  const served = async () => {
    const saved = savedOf(await download(fixture, 1, MAX))
    expect(saved).toEqual({ path: saved.path, name: "a.txt", type: "text/plain", size: 3, kind: "document" })
    expect(calls("getMessages")).toBe(1)
    expect([...readFileSync(join(outside, "file"))]).toEqual([...Buffer.from("secret")])
  }

  test("ignores a link in the place of the message's folder, and asks Telegram", async () => {
    mkdirSync(join(fixture.paths.kept, CHAT), { recursive: true })
    symlinkSync(outside, keptFolder(fixture, CHAT, 1))

    await served()
    expect(fixture.logs).toContain("a kept folder is not a plain folder; ignored")
  })

  test("ignores a link in the place of the chat's folder, and asks Telegram", async () => {
    mkdirSync(fixture.paths.kept, { recursive: true })
    mkdirSync(join(outside, "1"))
    writeFileSync(join(outside, "1", "file"), "secret")
    writeFileSync(join(outside, "1", "meta.json"), readFileSync(join(outside, "meta.json")))
    symlinkSync(outside, join(fixture.paths.kept, CHAT))

    await served()
    expect(fixture.logs).toContain("a kept folder is not a plain folder; ignored")
  })

  test("ignores a link to a file in a kept folder, and asks Telegram", async () => {
    const folder = keptFolder(fixture, CHAT, 1)
    mkdirSync(folder, { recursive: true })
    symlinkSync(join(outside, "file"), join(folder, "file"))
    writeFileSync(join(folder, "meta.json"), readFileSync(join(outside, "meta.json")))

    await served()
    expect(fixture.logs).toContain("a kept copy is unreadable; ignored")
  })

  test("ignores a folder whose facts are not valid, and asks Telegram", async () => {
    writeKept(fixture, CHAT, 1)
    writeFileSync(join(keptFolder(fixture, CHAT, 1), "meta.json"), JSON.stringify({ name: 5, kind: "document" }))

    await served()
    expect(fixture.logs).toContain("a kept copy is unreadable; ignored")
  })

  test("leaves a view-once file `forbidden` when nothing was kept", async () => {
    fixture.client.setHistory(CHAT, mediaMessage(2, fakeViewOncePhotoMedia()))

    expect(await failureOf(download(fixture, 2, MAX))).toMatchObject({
      code: "forbidden",
      message: "This file was meant to be seen once; it is not saved.",
    })
    expect(incomingFolders(fixture)).toEqual([])
  })
})
