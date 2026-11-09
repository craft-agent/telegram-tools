import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DeleteMessageUpdate } from "@mtcute/core"
import { fakeViewOncePhotoMedia } from "./fake-telegram-media.testing"
import { fakeDeleteUpdate } from "./fake-telegram.testing"
import { messageRow } from "./mirror.testing"
import { CHANNEL_ID, SUPERGROUP_ID, seedSyncChat } from "./sync-list.testing"
import { CHUNK, arriving, keptFolder, keptTree, push, viewOnceFile, waitKept, writeKept } from "./sync-keep.testing"
import { KEPT, request, seedKeptMessages, seedListedChats } from "./sync-requests.testing"
import { eventually, syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture
let outside: string

beforeEach(() => {
  fixture = syncFixture()
  fixture.client.setDownload([CHUNK])
  outside = mkdtempSync(join(tmpdir(), "tg-outside-"))
  writeFileSync(join(outside, "keep.txt"), "keep")
})

afterEach(() => {
  rmSync(outside, { recursive: true, force: true })
  return fixture.close()
})

const start = (overrides: Parameters<SyncFixture["running"]>[0] = {}) =>
  fixture.running({ keepDisappearing: true, ...overrides })
const deleteMessage = (id: number) =>
  fixture.client.onDeleteMessage.emit(new DeleteMessageUpdate(fakeDeleteUpdate([id])))
const untouched = () => expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep")

describe("a delete for everyone", () => {
  test("removes the kept file of the message with the message", async () => {
    await start()
    push(fixture, arriving(1, fakeViewOncePhotoMedia()))
    push(fixture, arriving(2, fakeViewOncePhotoMedia()))
    await waitKept(fixture, KEPT, 1)
    await waitKept(fixture, KEPT, 2)

    deleteMessage(1)

    await eventually(() => !existsSync(keptFolder(fixture, KEPT, 1)))
    expect(fixture.mirror((m) => messageRow(m, KEPT, 1))).toBeUndefined()
    expect(existsSync(keptFolder(fixture, KEPT, 2))).toBe(true)
  })

  test("that arrives while the file downloads leaves nothing of it", async () => {
    await start()
    const release = fixture.client.hold("downloadAsIterable")
    push(fixture, arriving(1, fakeViewOncePhotoMedia()))
    await eventually(() => keptTree(fixture).some((path) => path.endsWith(".part/file")))

    deleteMessage(1)
    release()

    await eventually(() => keptTree(fixture).every((path) => !path.includes("/")))
  })

  test("that is the timer's own keeps the file, as it keeps the message", async () => {
    await start({ heartbeatEveryMs: 1_000_000, gapAfterMs: 1e12 })
    push(fixture, arriving(1, viewOnceFile("a.txt", "text/plain", 3), { ttlPeriod: 3600 }))
    await waitKept(fixture, KEPT, 1)
    fixture.clock.advance(3_540_000)

    deleteMessage(1)

    expect(fixture.logs).toContain("event: delete kept=1")
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(existsSync(keptFolder(fixture, KEPT, 1))).toBe(true)
  })
})

describe("the start of the service with keeping on", () => {
  beforeEach(() => {
    seedListedChats(fixture)
    seedKeptMessages(fixture, 1, 1)
    writeKept(fixture, KEPT, 1)
  })

  test("removes the kept files of messages the mirror no longer has, and leaves the others", async () => {
    writeKept(fixture, KEPT, 2)
    writeKept(fixture, "-100123", 7)
    mkdirSync(join(fixture.paths.kept, KEPT, ".2.0123456789abcdef.part"))
    writeFileSync(join(fixture.paths.kept, "stray"), "x")

    await start()

    expect(keptTree(fixture)).toEqual([KEPT, `${KEPT}/1`, `${KEPT}/1/file`, `${KEPT}/1/meta.json`])
  })

  test("removes a link in kept/ itself and follows none", async () => {
    symlinkSync(outside, join(fixture.paths.kept, "-100123"))
    symlinkSync(outside, join(fixture.paths.kept, KEPT, "3"))
    symlinkSync(join(outside, "keep.txt"), join(fixture.paths.kept, KEPT, "4"))

    await start()

    expect(keptTree(fixture)).toEqual([KEPT, `${KEPT}/1`, `${KEPT}/1/file`, `${KEPT}/1/meta.json`])
    untouched()
  })

  test("removes kept/ itself when it is a link, and leaves what it points to", async () => {
    rmSync(fixture.paths.kept, { recursive: true })
    symlinkSync(outside, fixture.paths.kept)

    await start()

    expect(existsSync(fixture.paths.kept)).toBe(false)
    untouched()
  })

  test("removes the kept files of the channels that are turned off", async () => {
    seedSyncChat(fixture, { id: CHANNEL_ID, kind: "channel", listed: true })
    writeKept(fixture, CHANNEL_ID, 1)

    await start()

    expect(keptTree(fixture)).toEqual([KEPT, `${KEPT}/1`, `${KEPT}/1/file`, `${KEPT}/1/meta.json`])
  })

  test("removes the kept files of a chat that is no longer on the sync list", async () => {
    seedSyncChat(fixture, { id: SUPERGROUP_ID, kind: "supergroup", listed: false, followed: true })
    writeKept(fixture, SUPERGROUP_ID, 1)

    await start()

    expect(keptTree(fixture)).toEqual([KEPT, `${KEPT}/1`, `${KEPT}/1/file`, `${KEPT}/1/meta.json`])
  })
})

describe("the start of the service with keeping off", () => {
  test("removes all of kept/, and no link is followed", async () => {
    seedListedChats(fixture)
    seedKeptMessages(fixture, 1, 1)
    writeKept(fixture, KEPT, 1)
    symlinkSync(outside, join(fixture.paths.kept, KEPT, "3"))

    await fixture.running()

    expect(existsSync(fixture.paths.kept)).toBe(false)
    untouched()
    expect(fixture.mirror((m) => messageRow(m, KEPT, 1))).toBeDefined()
  })
})

describe("a chat taken off the sync list", () => {
  test("loses the kept files of its messages and keeps those of other chats", async () => {
    seedListedChats(fixture)
    seedKeptMessages(fixture, 1, 1)
    seedSyncChat(fixture, { id: SUPERGROUP_ID, kind: "supergroup", listed: true, ids: [1, 2] })
    writeKept(fixture, KEPT, 1)
    writeKept(fixture, SUPERGROUP_ID, 1)
    writeKept(fixture, SUPERGROUP_ID, 2)
    await start()
    expect(keptTree(fixture)).toContain(`${SUPERGROUP_ID}/2/meta.json`)

    await request(fixture, "sync_remove", { chats: [SUPERGROUP_ID] })

    await eventually(() => !existsSync(join(fixture.paths.kept, SUPERGROUP_ID)))
    expect(keptTree(fixture)).toEqual([KEPT, `${KEPT}/1`, `${KEPT}/1/file`, `${KEPT}/1/meta.json`])
  })
})

describe("the service closing", () => {
  test("stops a file being kept and leaves nothing of it", async () => {
    fixture.client.setDownload([CHUNK], "stall")
    const service = await start()
    push(fixture, arriving(1, fakeViewOncePhotoMedia()))
    await eventually(() => keptTree(fixture).some((path) => path.endsWith(".part/file")))

    service.stop()

    expect(await service.outcome).toEqual({ exitCode: 0, status: "stopped" })
    expect(keptTree(fixture)).toEqual([])
  })
})
