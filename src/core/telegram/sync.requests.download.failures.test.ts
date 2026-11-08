import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MtTimeoutError } from "@mtcute/core"
import { floodWait, rpcError } from "./login.testing"
import { failureOf } from "./service.testing"
import { CHAT, download, fileMedia, incomingFolders, mediaMessage } from "./sync-download.testing"
import { KEPT, keptMessage, request, seedListedChats } from "./sync-requests.testing"
import { eventually, syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

type Running = Awaited<ReturnType<SyncFixture["running"]>>

beforeEach(() => {
  fixture = syncFixture()
  seedListedChats(fixture)
  fixture.client.setHistory(CHAT, mediaMessage(1, fileMedia("a.txt", "text/plain", 3)))
})

afterEach(() => fixture.close())

const CHUNK = Uint8Array.of(1, 2, 3)
const downloads = () => fixture.client.argsOf("downloadAsIterable").length
const messageFetches = () => fixture.client.argsOf("getMessages").length

describe("a download that fails", () => {
  let service: Running

  beforeEach(async () => void (service = await fixture.running()))

  test("leaves no folder after an error in the middle, and tells it without Telegram's text", async () => {
    fixture.client.setDownload([CHUNK], new Error("socket to +15550100123 broke, session abc123"))

    expect(await failureOf(download(fixture, 1, 1000))).toMatchObject({
      code: "upstream_error",
      message: "Telegram did not answer the request; try again.",
    })
    expect(incomingFolders(fixture)).toEqual([])
    expect(fixture.logs.join("\n")).not.toMatch(/15550100123|abc123/)
  })

  test("leaves no folder after a flood wait in the middle, which is told and not retried", async () => {
    fixture.client.setDownload([CHUNK], floodWait(42))

    expect(await failureOf(download(fixture, 1, 1000))).toMatchObject({
      code: "upstream_error",
      message: "Telegram is limiting requests from this account; try again in 42 seconds.",
    })
    expect(downloads()).toBe(1)
    expect(fixture.pauses).not.toContain(42_000)
    expect(incomingFolders(fixture)).toEqual([])
  })

  test("leaves no folder when Telegram refuses the download at once", async () => {
    fixture.client.fail("downloadAsIterable", rpcError(400, "FILE_REFERENCE_EXPIRED"))

    expect(await failureOf(download(fixture, 1, 1000))).toMatchObject({
      code: "upstream_error",
      message: "Telegram refused the request (FILE_REFERENCE_EXPIRED).",
    })
    expect(incomingFolders(fixture)).toEqual([])
  })

  test("is told as it is when Telegram no longer gives the chat", async () => {
    fixture.client.fail("getMessages", rpcError(400, "CHANNEL_PRIVATE"))

    expect(await failureOf(download(fixture, 1, 1000))).toMatchObject({ code: "not_found" })
    expect(downloads()).toBe(0)
  })

  test("ends the run when the session ended in the middle", async () => {
    fixture.client.setDownload([CHUNK], rpcError(401, "AUTH_KEY_UNREGISTERED"))

    expect(await failureOf(download(fixture, 1, 1000))).toMatchObject({ code: "upstream_error" })
    expect(await service.outcome).toMatchObject({ exitCode: 0, status: "logged out" })
    expect(incomingFolders(fixture)).toEqual([])
  })
})

describe("a download stalled after some bytes", () => {
  let service: Running

  beforeEach(async () => void (service = await fixture.running()))

  /** Starts a download that serves one chunk and then waits, and returns its answer once the chunk is on disk. */
  const stalled = async (signal?: AbortSignal): Promise<{ answer: Promise<unknown> }> => {
    fixture.client.setDownload([CHUNK], "stall")
    const answer = download(fixture, 1, 1000, CHAT, signal).catch((error) => error)
    const written = () => {
      const [folder] = incomingFolders(fixture)
      const file = folder && join(fixture.paths.incoming, folder, "file")
      return Boolean(file && existsSync(file) && statSync(file).size === CHUNK.length)
    }
    await eventually(written)
    return { answer }
  }

  test("is removed with its folder when the caller leaves", async () => {
    const caller = new AbortController()
    const { answer } = await stalled(caller.signal)

    caller.abort()

    expect(await answer).toBeInstanceOf(Error)
    await eventually(() => incomingFolders(fixture).length === 0)
  })

  test("is removed with its folder when the service stops", async () => {
    const { answer } = await stalled()

    service.stop()

    expect(await service.outcome).toEqual({ exitCode: 0, status: "stopped" })
    expect(await answer).toBeInstanceOf(Error)
    await eventually(() => incomingFolders(fixture).length === 0)
  })
})

describe("a download that receives nothing for the stall limit", () => {
  beforeEach(async () => void (await fixture.running({ downloadStallMs: 50 })))

  test("stops with the folder removed, and says it stalled", async () => {
    fixture.client.setDownload([CHUNK], "stall")

    expect(await failureOf(download(fixture, 1, 1000))).toMatchObject({
      code: "upstream_error",
      message: "The download received nothing for 0.05 seconds; try again later.",
    })
    expect(fixture.client.argsOf("downloadAsIterable")).toEqual([{ kind: "document", stallTimeout: 50 }])
    expect(incomingFolders(fixture)).toEqual([])
  })

  test("is told apart from a timeout of Telegram's own", async () => {
    fixture.client.setDownload([CHUNK], new MtTimeoutError(5))

    expect(await failureOf(download(fixture, 1, 1000))).toMatchObject({
      code: "upstream_error",
      message: "Telegram did not answer the request; try again.",
    })
    expect(incomingFolders(fixture)).toEqual([])
  })
})

describe("downloads in turn", () => {
  beforeEach(async () => void (await fixture.running()))

  test("run one at a time, the second waiting for the first", async () => {
    fixture.client.setDownload([CHUNK])
    const release = fixture.client.hold("downloadAsIterable")

    const first = download(fixture, 1, 1000)
    await eventually(() => downloads() === 1)
    const second = download(fixture, 1, 1000)
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(messageFetches()).toBe(1)
    release()
    expect(await first).toHaveProperty("saved")
    expect(await second).toHaveProperty("saved")
    expect(messageFetches()).toBe(2)
    expect(downloads()).toBe(2)
  })

  test("are not held up by a history fetch that is running", async () => {
    fixture.client.setDownload([CHUNK])
    fixture.client.setHistory(KEPT, keptMessage(1))
    const release = fixture.client.hold("getHistory")
    const fetching = request(fixture, "fetch", { chat: KEPT, pages: 1 })
    await eventually(() => fixture.client.argsOf("getHistory").length === 1)

    expect(await download(fixture, 1, 1000)).toHaveProperty("saved")

    release()
    await fetching
  })
})

describe("the start of the service", () => {
  let outside: string

  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), "tg-outside-"))
    writeFileSync(join(outside, "keep.txt"), "keep")
  })

  afterEach(() => rmSync(outside, { recursive: true, force: true }))

  test("removes what a service that was killed left in incoming/", async () => {
    const left = join(fixture.paths.incoming, "0123456789abcdef0123456789abcdef")
    mkdirSync(left, { recursive: true })
    writeFileSync(join(left, "file"), "partial")
    writeFileSync(join(fixture.paths.incoming, "stray"), "x")

    await fixture.running()

    expect(existsSync(fixture.paths.incoming)).toBe(true)
    expect(incomingFolders(fixture)).toEqual([])
  })

  test("removes a link in incoming/ itself, and leaves what it points to", async () => {
    mkdirSync(fixture.paths.incoming, { recursive: true })
    symlinkSync(outside, join(fixture.paths.incoming, "folder-link"))
    symlinkSync(join(outside, "keep.txt"), join(fixture.paths.incoming, "file-link"))

    await fixture.running()

    expect(incomingFolders(fixture)).toEqual([])
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep")
  })

  test("removes incoming/ itself when it is a link, and leaves what it points to", async () => {
    symlinkSync(outside, fixture.paths.incoming)

    await fixture.running()

    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep")
    fixture.client.setDownload([CHUNK])
    const result = await download(fixture, 1, 1000)
    expect(result).toHaveProperty("saved")
    expect(existsSync(join(outside, "file"))).toBe(false)
  })
})
