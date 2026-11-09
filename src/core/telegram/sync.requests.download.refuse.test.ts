import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { dirname } from "node:path"
import { BYTES_PER_MB } from "./service-requests"
import { CHAT, download, fileMedia, incomingFolders, mediaMessage } from "./sync-download.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"
import { seedListedChats } from "./sync-requests.testing"

let fixture: SyncFixture

beforeAll(async () => {
  fixture = syncFixture()
  seedListedChats(fixture)
  await fixture.running()
})

afterAll(() => fixture.close())

beforeEach(() => {
  fixture.client.calls.length = 0
  fixture.client.setDownload([Uint8Array.of(1, 2, 3)])
})

const MAX = 10 * BYTES_PER_MB

/** Serves a message `1` with this file and asks for it with a limit of 10 MB. */
async function ask(name: string | null, type: string, size = 100) {
  fixture.client.setHistory(CHAT, mediaMessage(1, fileMedia(name, type, size)))
  return download(fixture, 1, MAX)
}

const notDownloaded = () => {
  expect(fixture.client.argsOf("downloadAsIterable")).toEqual([])
  expect(incomingFolders(fixture)).toEqual([])
}

describe("a file refused by what its sender declares of it", () => {
  const refused: [string, string | null, string, string][] = [
    ["a program by its name", "setup.exe", "application/octet-stream", "a program"],
    ["a program by its name in any case, with a trailing dot", "SETUP.EXE.", "application/octet-stream", "a program"],
    ["a program by its type", "download.bin", "application/x-msdownload", "a program"],
    ["a program by its type with parameters", "download.bin", "Application/X-MSDownload; charset=binary", "a program"],
    ["an installer", "setup.msi", "application/octet-stream", "an installer"],
    [
      "an animated sticker",
      "sticker.tgs",
      "application/x-tgsticker",
      "an animated sticker (.tgs), which cannot be inspected",
    ],
    [
      "an archive that cannot be inspected",
      "a.rar",
      "application/octet-stream",
      "an archive that cannot be inspected (rar)",
    ],
    [
      "a document with macros by its type",
      "report",
      "application/vnd.ms-excel.sheet.macroEnabled.12",
      "a document with macros",
    ],
  ]

  for (const [name, fileName, type, reason] of refused) {
    test(`refuses ${name} without downloading`, async () => {
      expect(await ask(fileName, type)).toEqual({
        refused: { name: fileName, type, size: 100, kind: "document", reason },
      })
      notDownloaded()
    })
  }
})

describe("a file too large", () => {
  test("is refused by its declared size, in whole megabytes rounded up", async () => {
    expect(await ask("big.txt", "text/plain", MAX + 1)).toEqual({
      refused: {
        name: "big.txt",
        type: "text/plain",
        size: MAX + 1,
        kind: "document",
        reason: "it is 11 MB, over the 10 MB download limit",
      },
    })
    notDownloaded()
  })

  test("is refused at the first byte over a limit that is not whole megabytes", async () => {
    fixture.client.setHistory(CHAT, mediaMessage(1, fileMedia("big.txt", "text/plain", 1501)))

    expect(await download(fixture, 1, 1500)).toMatchObject({
      refused: { size: 1501, reason: "it is 1 MB, over the 1 MB download limit" },
    })
    notDownloaded()
  })

  test("is taken when it is exactly the limit", async () => {
    const result = await ask("exact.txt", "text/plain", MAX)

    expect(result).toMatchObject({ saved: { name: "exact.txt", size: 3 } })
    if ("saved" in result) rmSync(dirname(result.saved.path), { recursive: true })
  })
})

describe("a file that is left to the inspection of its bytes", () => {
  for (const [name, fileName, type] of [
    ["a zip", "a.zip", "application/zip"],
    [
      "a document built on zip",
      "report.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    ["a gzipped tar", "a.tgz", "application/gzip"],
    ["source code", "run.sh", "text/x-shellscript"],
  ] as const) {
    test(`downloads ${name}`, async () => {
      const result = await ask(fileName, type)

      expect(result).toMatchObject({ saved: { name: fileName, type } })
      if ("saved" in result) rmSync(dirname(result.saved.path), { recursive: true })
    })
  }
})
