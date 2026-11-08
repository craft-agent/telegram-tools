import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fakePhotoMedia } from "./fake-telegram-media.testing"
import { FAKE_DATE } from "./fake-telegram.testing"
import type { DownloadResult, SavedFile } from "./service-requests"
import { DOWNLOAD_STALL_MS } from "./sync-download"
import { CHAT, download, fileMedia, incomingFolders, mediaMessage } from "./sync-download.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"
import { seedListedChats } from "./sync-requests.testing"

let fixture: SyncFixture

beforeEach(async () => {
  fixture = syncFixture()
  seedListedChats(fixture)
  await fixture.running()
})

afterEach(() => fixture.close())

const MAX = 1000
const modeOf = (path: string) => statSync(path).mode & 0o777

function savedOf(result: DownloadResult): SavedFile {
  if (!("saved" in result)) throw new Error(`expected a saved file, got ${JSON.stringify(result)}`)
  return result.saved
}

describe("a file that is downloaded", () => {
  test("is written as `file` in a private folder of its own under incoming/", async () => {
    fixture.client.setHistory(CHAT, mediaMessage(1, fileMedia("report.pdf", "application/pdf", 5)))
    fixture.client.setDownload([Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5)])

    const saved = savedOf(await download(fixture, 1, MAX))

    expect(saved).toEqual({
      path: saved.path,
      name: "report.pdf",
      type: "application/pdf",
      size: 5,
      kind: "document",
    })
    const folder = dirname(saved.path)
    expect(dirname(folder)).toBe(fixture.paths.incoming)
    expect(basename(folder)).toMatch(/^[0-9a-f]{32}$/)
    expect(basename(saved.path)).toBe("file")
    expect(modeOf(fixture.paths.incoming)).toBe(0o700)
    expect(modeOf(folder)).toBe(0o700)
    expect(modeOf(saved.path)).toBe(0o600)
    expect([...readFileSync(saved.path)]).toEqual([1, 2, 3, 4, 5])
    expect(incomingFolders(fixture)).toEqual([basename(folder)])
  })

  test("gives each download a folder of its own", async () => {
    fixture.client.setHistory(CHAT, mediaMessage(1, fileMedia("a.txt", "text/plain", 1)))
    fixture.client.setDownload([Uint8Array.of(1)])

    const first = savedOf(await download(fixture, 1, MAX))
    const second = savedOf(await download(fixture, 1, MAX))

    expect(dirname(first.path)).not.toBe(dirname(second.path))
    expect(incomingFolders(fixture)).toHaveLength(2)
  })

  test("is named by the sender only in the answer, never on disk", async () => {
    const name = "../../../etc/passwd\u202Etxt.exe.txt"
    fixture.client.setHistory(CHAT, mediaMessage(1, fileMedia(name, "text/plain", 1)))
    fixture.client.setDownload([Uint8Array.of(1)])

    const saved = savedOf(await download(fixture, 1, MAX))

    expect(saved.name).toBe(name)
    expect(saved.path).toBe(join(dirname(saved.path), "file"))
    expect(incomingFolders(fixture)).toHaveLength(1)
  })

  test("reports the bytes written as the size, not what the sender declared", async () => {
    fixture.client.setHistory(CHAT, mediaMessage(1, fileMedia("a.txt", "text/plain", 900)))
    fixture.client.setDownload([Uint8Array.of(1, 2, 3)])

    expect(savedOf(await download(fixture, 1, MAX)).size).toBe(3)
  })

  test("is an empty file when Telegram serves no bytes", async () => {
    fixture.client.setHistory(CHAT, mediaMessage(1, fileMedia("empty.txt", "text/plain", 0)))
    fixture.client.setDownload([])

    const saved = savedOf(await download(fixture, 1, MAX))

    expect(saved.size).toBe(0)
    expect(readFileSync(saved.path)).toHaveLength(0)
  })
})

describe("a photo that is downloaded", () => {
  test("has no name and no type", async () => {
    fixture.client.setHistory(CHAT, mediaMessage(1, fakePhotoMedia()))
    fixture.client.setDownload([Uint8Array.of(9, 9)])

    const saved = savedOf(await download(fixture, 1, 200_000))

    expect(saved).toEqual({ path: saved.path, name: null, type: null, size: 2, kind: "photo" })
    expect(fixture.client.argsOf("downloadAsIterable")).toEqual([{ kind: "photo", stallTimeout: DOWNLOAD_STALL_MS }])
  })
})

describe("a file of a message that disappears", () => {
  test("comes with the time the message goes", async () => {
    fixture.client.setHistory(
      CHAT,
      mediaMessage(1, fileMedia("a.txt", "text/plain", 1), { ttlPeriod: 3600 }),
      mediaMessage(2, fileMedia("b.txt", "text/plain", 1)),
    )
    fixture.client.setDownload([Uint8Array.of(1)])

    expect(savedOf(await download(fixture, 1, MAX)).disappears_at).toBe((FAKE_DATE + 3600) * 1000)
    expect(savedOf(await download(fixture, 2, MAX))).not.toHaveProperty("disappears_at")
  })
})

describe("the byte limit", () => {
  const chunks = [new Uint8Array(10), new Uint8Array(10), new Uint8Array(10)]

  test("is enforced on the bytes that arrive when the declared size is under it", async () => {
    fixture.client.setHistory(CHAT, mediaMessage(1, fileMedia("liar.txt", "text/plain", 5)))
    fixture.client.setDownload(chunks)

    expect(await download(fixture, 1, 25)).toEqual({
      refused: {
        name: "liar.txt",
        type: "text/plain",
        size: 5,
        kind: "document",
        reason: "it is 1 MB, over the 1 MB download limit",
      },
    })
    expect(incomingFolders(fixture)).toEqual([])
  })

  test("is enforced when Telegram declares no size, and says so without one", async () => {
    const media = fakePhotoMedia()
    ;(media.photo as { sizes: unknown[] }).sizes = [{ _: "photoSizeProgressive", type: "y", w: 800, h: 600, sizes: [] }]
    fixture.client.setHistory(CHAT, mediaMessage(1, media))
    fixture.client.setDownload(chunks)

    expect(await download(fixture, 1, 25)).toMatchObject({
      refused: { name: null, size: null, kind: "photo", reason: "it is over the 1 MB download limit" },
    })
    expect(incomingFolders(fixture)).toEqual([])
  })

  test("lets through exactly the limit, and refuses one byte more", async () => {
    fixture.client.setHistory(CHAT, mediaMessage(1, fileMedia("a.txt", "text/plain", 1)))
    fixture.client.setDownload(chunks)

    expect(savedOf(await download(fixture, 1, 30)).size).toBe(30)
    expect(await download(fixture, 1, 29)).toHaveProperty("refused")
    expect(incomingFolders(fixture)).toHaveLength(1)
  })
})
