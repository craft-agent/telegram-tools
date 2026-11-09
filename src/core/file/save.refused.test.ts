import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { gzipSync } from "node:zlib"
import { ELF_BYTES, PE_BYTES } from "../archive/archive.testing"
import { DEFAULT_LIMITS } from "../archive/limits"
import { buildTar } from "../archive/tar.testing"
import { buildZip } from "../archive/zip.testing"
import { USER } from "../telegram/mirror.testing"
import type { RefusedFile } from "../telegram/service-requests"
import { MESSAGE_ID, createSaveFixture, saveArgs, type SaveFixture } from "./save.testing"

let t: SaveFixture

beforeEach(() => {
  t = createSaveFixture()
})
afterEach(() => t.close())

/** Saves a file with these bytes under a declared name and type; the result of the call. */
async function save(content: Buffer | string, name: string | null, type: string | null = null, kind = "document") {
  await t.serveFile(content, { name, type, kind })
  return t.save(saveArgs())
}

/** Nothing of the file is anywhere: no folder under the download directory, nothing left in `incoming/`. */
function expectNothingLeft(): void {
  expect(readdirSync(t.downloadDir)).toEqual([])
  expect(t.incomingNames()).toEqual([])
}

describe("a file the service refuses", () => {
  const refusal = (overrides: Partial<RefusedFile> = {}): RefusedFile => ({
    name: "setup.exe",
    type: "application/x-msdownload",
    size: 10,
    kind: "document",
    reason: "a program",
    ...overrides,
  })

  test("is listed under refused with its reason, and no folder is made", async () => {
    await t.serve(() => ({ refused: refusal() }))
    const result = await t.save(saveArgs())
    expect(result).toMatchObject({ chat: USER, id: MESSAGE_ID, folder: t.folder, files: [] })
    expect(result.refused).toEqual([{ name: "setup.exe", reason: "a program" }])
    expect(result.errors).toBeUndefined()
    expectNothingLeft()
  })

  test("shows the name cleaned, and a file with no name by its kind", async () => {
    await t.serve(() => ({ refused: refusal({ name: "../evil\u202E.exe" }) }))
    expect((await t.save(saveArgs())).refused![0]!.name).toBe("_.._evil_.exe")
    await t.serve(() => ({
      refused: refusal({ name: null, kind: "photo", reason: "it is 200 MB, over the 100 MB download limit" }),
    }))
    expect((await t.save(saveArgs())).refused).toEqual([
      { name: "photo", reason: "it is 200 MB, over the 100 MB download limit" },
    ])
  })
})

describe("a file whose bytes are refused", () => {
  test("a program is refused by its name, whatever its bytes", async () => {
    const result = await save("harmless text", "setup.exe")
    expect(result.files).toEqual([])
    expect(result.refused).toEqual([{ name: "setup.exe", reason: "a program" }])
    expectNothingLeft()
  })

  test.each([
    ["ELF", ELF_BYTES],
    ["PE", PE_BYTES],
  ])("%s bytes are refused under an innocent name and type", async (_label, bytes) => {
    const result = await save(bytes, "cat.pdf", "application/pdf")
    expect(result.refused).toEqual([{ name: "cat.pdf", reason: "a program" }])
    expectNothingLeft()
  })

  test("a nameless photo that is a program is listed by its kind", async () => {
    const result = await save(ELF_BYTES, null, "image/jpeg", "photo")
    expect(result.refused).toEqual([{ name: "photo", reason: "a program" }])
  })

  test("an animated sticker (gzipped Lottie) is refused", async () => {
    const result = await save(gzipSync('{"v":"5.5.2"}'), "sticker.tgs", "application/x-tgsticker", "sticker")
    expect(result.files).toEqual([])
    expect(result.refused).toHaveLength(1)
    expectNothingLeft()
  })

  test("an archive that cannot be inspected is refused, and so is a mislabeled one", async () => {
    expect((await save("x", "files.7z")).refused![0]!.reason).toContain("cannot be inspected (7z)")
    const rar = Buffer.concat([Buffer.from("Rar!\x1a\x07\x00"), Buffer.alloc(32)])
    expect((await save(rar, "files.zip", "application/zip")).refused![0]!.reason).toContain("cannot be inspected")
    expect((await save("plain text", "files.zip")).refused![0]!.reason).toContain("mislabeled")
    expectNothingLeft()
  })

  test("an installer and a macro document are refused with their reasons", async () => {
    expect((await save("x", "tool.msi")).refused![0]!.reason).toBe("an installer")
    expect((await save("x", "budget.xlsm")).refused![0]!.reason).toBe("a document with macros")
  })

  test("source code is saved as text", async () => {
    const result = await save("#!/bin/sh\n", "build.sh")
    expect(result.files.map((file) => file.name)).toEqual(["build.sh"])
    expect(result.refused).toBeUndefined()
  })
})

describe("what a hostile archive does", () => {
  test("a zip holding a program is refused with the reason, and nothing is saved", async () => {
    const zip = buildZip([
      { name: "docs/readme.txt", data: "hi" },
      { name: "docs/run.sh.exe", data: "x" },
    ])
    const result = await save(zip, "docs.zip", "application/zip")
    expect(result.files).toEqual([])
    expect(result.refused).toEqual([{ name: "docs.zip", reason: "the entry docs/run.sh.exe is a program" }])
    expectNothingLeft()
  })

  test.each([
    ["zip slip", [{ name: "../evil.txt", data: "x" }], "not a plain relative one"],
    ["an ELF under a plain name", [{ name: "data.bin", data: ELF_BYTES }], "is a program"],
    ["a nested archive", [{ name: "inner.zip", data: buildZip([{ name: "a", data: "b" }]) }], "archive inside"],
    ["a bundle", [{ name: "X.app/Contents/run", data: "#!/bin/sh" }], "app or system bundle"],
  ])("%s is refused and nothing is left", async (_label, entries, reason) => {
    const result = await save(buildZip(entries), "x.zip")
    expect(result.refused![0]!.reason).toContain(reason)
    expectNothingLeft()
  })

  test("a zip bomb and a gzipped tar bomb are refused by what they unpack to, under a small limit", async () => {
    const limits = { ...DEFAULT_LIMITS, maxTotalSize: 100 * 1024 }
    const zeros = Buffer.alloc(4_000_000)
    await t.serveFile(buildZip([{ name: "zeros.bin", data: zeros }]), { name: "bomb.zip" })
    const zip = await t.save(saveArgs(), { host: { limits } })
    expect(zip.refused).toEqual([{ name: "bomb.zip", reason: "the archive unpacks to more than 102400 bytes" }])
    await t.serveFile(gzipSync(buildTar([{ name: "zeros.bin", data: zeros }])), { name: "bomb.tar.gz" })
    const tgz = await t.save(saveArgs(), { host: { limits } })
    expect(tgz.refused![0]!.reason).toContain("unpacks to more than")
    expectNothingLeft()
  })
})
