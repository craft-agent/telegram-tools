import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fakePhotoMedia, fakeViewOncePhotoMedia } from "./fake-telegram-media.testing"
import { FAKE_DATE } from "./fake-telegram.testing"
import { messageRow } from "./mirror.testing"
import type { KeptMeta } from "./sync-kept-store"
import { DOWNLOAD_STALL_MS } from "./sync-download"
import { CHAT, download, fileMedia, mediaMessage } from "./sync-download.testing"
import { CHUNK, arriving, keptFolder, keptTree, push, selfDestructingVideo, waitKept } from "./sync-keep.testing"
import { KEPT, request, seedKeptMessages, seedListedChats } from "./sync-requests.testing"
import { eventually, syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeEach(() => {
  fixture = syncFixture()
  fixture.client.setDownload([CHUNK])
})

afterEach(() => fixture.close())

const modeOf = (path: string) => statSync(path).mode & 0o777
const downloads = () => fixture.client.argsOf("downloadAsIterable").length
const metaOf = (id: number): KeptMeta =>
  JSON.parse(readFileSync(join(keptFolder(fixture, KEPT, id), "meta.json"), "utf8"))

/** Lets the service handle what was pushed, then shows that nothing was downloaded or kept. */
async function expectNothingKept(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(downloads()).toBe(0)
  expect(keptTree(fixture)).toEqual([])
}

describe("a disappearing file that arrives with keeping on", () => {
  beforeEach(async () => void (await fixture.running({ keepDisappearing: true })))

  const kinds: [string, () => ReturnType<typeof arriving>, KeptMeta][] = [
    [
      "a view-once photo",
      () => arriving(1, fakeViewOncePhotoMedia()),
      { name: null, type: null, kind: "photo", size: 3 },
    ],
    [
      "a self-destructing video",
      () => arriving(1, selfDestructingVideo()),
      { name: "clip.mp4", type: "video/mp4", kind: "video", size: 3 },
    ],
    [
      "a document with a timer",
      () => arriving(1, fileMedia("a.txt", "text/plain", 3), { ttlPeriod: 3600 }),
      { name: "a.txt", type: "text/plain", kind: "document", size: 3, disappears_at: (FAKE_DATE + 3600) * 1000 },
    ],
  ]

  for (const [name, message, meta] of kinds) {
    test(`keeps ${name} in a private folder with its facts`, async () => {
      push(fixture, message())
      await waitKept(fixture, KEPT, 1)

      const folder = keptFolder(fixture, KEPT, 1)
      expect(keptTree(fixture)).toEqual([KEPT, `${KEPT}/1`, `${KEPT}/1/file`, `${KEPT}/1/meta.json`])
      for (const dir of [fixture.paths.kept, join(fixture.paths.kept, KEPT), folder]) expect(modeOf(dir)).toBe(0o700)
      for (const file of ["file", "meta.json"]) expect(modeOf(join(folder, file))).toBe(0o600)
      expect([...readFileSync(join(folder, "file"))]).toEqual([...CHUNK])
      expect(metaOf(1)).toEqual(meta)
    })
  }

  test("stores the update without waiting for the download", async () => {
    const release = fixture.client.hold("downloadAsIterable")

    push(fixture, arriving(1, fakeViewOncePhotoMedia()))

    expect(fixture.mirror((m) => messageRow(m, KEPT, 1))).toMatchObject({ view_once: 1 })
    expect(fixture.logs).toContain("event: message stored")
    await eventually(() => downloads() === 1)
    expect(existsSync(keptFolder(fixture, KEPT, 1))).toBe(false)
    release()
    await waitKept(fixture, KEPT, 1)
  })

  test("downloads with the byte limit and the stall limit of a download", async () => {
    push(fixture, arriving(1, fakeViewOncePhotoMedia()))
    await waitKept(fixture, KEPT, 1)

    expect(fixture.client.argsOf("downloadAsIterable")).toEqual([{ kind: "photo", stallTimeout: DOWNLOAD_STALL_MS }])
  })

  test("keeps each file under its own message", async () => {
    push(fixture, arriving(1, fakeViewOncePhotoMedia()))
    push(fixture, arriving(2, fakeViewOncePhotoMedia()))
    await waitKept(fixture, KEPT, 1)
    await waitKept(fixture, KEPT, 2)

    expect(keptTree(fixture).filter((path) => path.endsWith("/file"))).toEqual([`${KEPT}/1/file`, `${KEPT}/2/file`])
  })
})

describe("keeping and downloading in turn", () => {
  test("run one at a time through the same queue", async () => {
    seedListedChats(fixture)
    fixture.client.setHistory(CHAT, mediaMessage(1, fileMedia("a.txt", "text/plain", 3)))
    await fixture.running({ keepDisappearing: true })
    const release = fixture.client.hold("downloadAsIterable")

    push(fixture, arriving(1, fakeViewOncePhotoMedia()))
    await eventually(() => downloads() === 1)
    const asked = download(fixture, 1, 1000)
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(fixture.client.argsOf("getMessages")).toEqual([])
    release()
    expect(await asked).toMatchObject({ saved: { name: "a.txt" } })
    await waitKept(fixture, KEPT, 1)
    expect(downloads()).toBe(2)
  })
})

describe("what arrives and is not kept", () => {
  test("a disappearing file is not kept with keeping off", async () => {
    await fixture.running()

    push(fixture, arriving(1, fakeViewOncePhotoMedia()))

    await expectNothingKept()
    expect(fixture.mirror((m) => messageRow(m, KEPT, 1))).toBeDefined()
    expect(existsSync(fixture.paths.kept)).toBe(false)
  })

  test("a file of a message that does not disappear is not kept", async () => {
    await fixture.running({ keepDisappearing: true })

    push(fixture, arriving(1, fakePhotoMedia()))

    await expectNothingKept()
    expect(fixture.mirror((m) => messageRow(m, KEPT, 1))).toBeDefined()
  })

  test("a message of a history fetch is not kept", async () => {
    seedListedChats(fixture)
    seedKeptMessages(fixture, 5, 6)
    fixture.client.setHistory(KEPT, arriving(2, fakeViewOncePhotoMedia(), { date: FAKE_DATE + 2 }))
    await fixture.running({ keepDisappearing: true })

    await request(fixture, "fetch", { chat: KEPT, pages: 1 })

    expect(fixture.mirror((m) => messageRow(m, KEPT, 2))).toMatchObject({ view_once: 1 })
    await expectNothingKept()
  })

  test("an edit is not kept", async () => {
    seedListedChats(fixture)
    seedKeptMessages(fixture, 1, 1)
    await fixture.running({ keepDisappearing: true })

    fixture.client.onEditMessage.emit(arriving(1, fakeViewOncePhotoMedia(), { editDate: FAKE_DATE + 60 }))

    await eventually(() => fixture.logs.includes("event: edit edited"))
    await expectNothingKept()
  })

  test("a message the mirror has is not kept again when it is replayed", async () => {
    await fixture.running({ keepDisappearing: true })
    push(fixture, arriving(1, fakeViewOncePhotoMedia()))
    await waitKept(fixture, KEPT, 1)

    push(fixture, arriving(1, fakeViewOncePhotoMedia()))

    expect(fixture.logs).toContain("event: message unchanged")
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(downloads()).toBe(1)
  })
})
