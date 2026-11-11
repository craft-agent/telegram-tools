import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ELF_BYTES } from "../archive/archive.testing"
import { floodWait, rpcError } from "./login.testing"
import { BYTES_PER_MB } from "./service-requests"
import { KEPT_MAX_BYTES } from "./sync-keep"
import { CHUNK, arriving, keptTree, push, viewOnceFile, waitKept } from "./sync-keep.testing"
import { KEPT } from "./sync-requests.testing"
import { eventually, syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeEach(() => {
  fixture = syncFixture()
  fixture.client.setDownload([CHUNK])
})

afterEach(() => fixture.close())

const downloads = () => fixture.client.argsOf("downloadAsIterable").length
const start = (overrides: Parameters<SyncFixture["running"]>[0] = {}) =>
  fixture.running({ keepDisappearing: true, ...overrides })

const REFUSED = "a disappearing file was not kept: its name or type is refused"
const ARCHIVE = "a disappearing file was not kept: it is an archive"
const DECLARED_SIZE = "a disappearing file was not kept: it is over the size limit"
const RECEIVED_SIZE = "a disappearing file was not kept: it passed the size limit"
const BYTES = "a disappearing file was not kept: its bytes are not a plain file"
const FAILED = "a disappearing file could not be kept"

/** Waits until the copy was given up, with the line the log tells it by, and the staging folder is gone. */
async function expectDropped(line: string): Promise<void> {
  await eventually(() => fixture.logs.includes(line))
  await eventually(() => keptTree(fixture).length === 0)
}

describe("a disappearing file refused by what its sender declares of it", () => {
  const cases: [string, string, string, string][] = [
    ["a program", "setup.exe", "application/octet-stream", REFUSED],
    ["an installer", "setup.msi", "application/octet-stream", REFUSED],
    ["an animated sticker", "sticker.tgs", "application/x-tgsticker", REFUSED],
    ["a zip", "a.zip", "application/zip", ARCHIVE],
    ["a gzipped tar by its name", "a.tgz", "application/octet-stream", ARCHIVE],
    ["a tar by its type", "backup", "application/x-tar", ARCHIVE],
  ]

  for (const [name, fileName, type, line] of cases) {
    test(`is not kept, nor downloaded: ${name}`, async () => {
      await start()

      push(fixture, arriving(1, viewOnceFile(fileName, type, 3)))

      expect(fixture.logs).toContain(line)
      expect(downloads()).toBe(0)
      expect(keptTree(fixture)).toEqual([])
    })
  }

  test("is kept when it is a document built on zip, which is a file and not an archive", async () => {
    fixture.client.setDownload([Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0)])
    await start()
    const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

    push(fixture, arriving(1, viewOnceFile("report.docx", docx, 8)))

    await waitKept(fixture, KEPT, 1)
  })
})

describe("a disappearing file by its size", () => {
  test("is not kept, nor downloaded, when it declares more than 100 MB", async () => {
    await start()

    push(fixture, arriving(1, viewOnceFile("big.txt", "text/plain", KEPT_MAX_BYTES + 1)))

    expect(fixture.logs).toContain(DECLARED_SIZE)
    expect(downloads()).toBe(0)
    expect(keptTree(fixture)).toEqual([])
  })

  test("is kept when it declares exactly 100 MB and the bytes are fewer", async () => {
    await start()

    push(fixture, arriving(1, viewOnceFile("big.txt", "text/plain", KEPT_MAX_BYTES)))

    await waitKept(fixture, KEPT, 1)
  })

  test("is cut at 100 MB when it declares less and sends more, and leaves nothing", async () => {
    fixture.client.setDownload([new Uint8Array(60 * BYTES_PER_MB), new Uint8Array(60 * BYTES_PER_MB)])
    await start()

    push(fixture, arriving(1, viewOnceFile("liar.txt", "text/plain", 5)))

    await expectDropped(RECEIVED_SIZE)
  })
})

describe("a disappearing file by its bytes", () => {
  test("is not kept when they are a program under the name of a picture", async () => {
    fixture.client.setDownload([ELF_BYTES])
    await start()

    push(fixture, arriving(1, viewOnceFile("photo.jpg", "image/jpeg", ELF_BYTES.length)))

    await expectDropped(BYTES)
    expect(downloads()).toBe(1)
  })
})

describe("a download that fails", () => {
  /** The next message, to show that the service goes on keeping. */
  async function expectStillKeeping(): Promise<void> {
    fixture.client.setDownload([CHUNK])
    push(fixture, arriving(2, viewOnceFile("next.txt", "text/plain", 3)))
    await waitKept(fixture, KEPT, 2)
    expect(fixture.meta().status).toBe("running")
  }

  test("leaves nothing after an error in the middle, and logs a fixed line without Telegram's text", async () => {
    fixture.client.setDownload([CHUNK], new Error("socket to +15550100123 broke, session abc123"))
    await start()

    push(fixture, arriving(1, viewOnceFile("a.txt", "text/plain", 3)))

    await expectDropped(FAILED)
    expect(fixture.logs.join("\n")).not.toMatch(/15550100123|abc123/)
    await expectStillKeeping()
  })

  test("leaves nothing after a flood wait, which is not waited out", async () => {
    fixture.client.setDownload([CHUNK], floodWait(42))
    await start()

    push(fixture, arriving(1, viewOnceFile("a.txt", "text/plain", 3)))

    await expectDropped(FAILED)
    expect(fixture.pauses).not.toContain(42_000)
    expect(downloads()).toBe(1)
    await expectStillKeeping()
  })

  test("leaves nothing when Telegram refuses the download at once", async () => {
    fixture.client.fail("downloadAsIterable", rpcError(400, "FILE_REFERENCE_EXPIRED"))
    await start()

    push(fixture, arriving(1, viewOnceFile("a.txt", "text/plain", 3)))

    await expectDropped(FAILED)
    await expectStillKeeping()
  })

  test("leaves nothing when it receives nothing for the stall limit", async () => {
    fixture.client.setDownload([CHUNK], "stall")
    await start({ transferStallMs: 50 })

    push(fixture, arriving(1, viewOnceFile("a.txt", "text/plain", 3)))

    await expectDropped(FAILED)
    expect(fixture.client.argsOf("downloadAsIterable")).toEqual([{ kind: "document", stallTimeout: 50 }])
    await expectStillKeeping()
  })
})
