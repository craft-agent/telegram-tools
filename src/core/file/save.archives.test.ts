import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { buildTar } from "../archive/tar.testing"
import { buildZip, type ZipEntry } from "../archive/zip.testing"
import { RESULT_BUDGET } from "../pages"
import { createSaveFixture, saveArgs, type SaveFixture } from "./save.testing"

let t: SaveFixture

beforeEach(() => {
  t = createSaveFixture()
})
afterEach(() => t.close())

async function saveArchive(name: string, bytes: Buffer, type?: string) {
  await t.serveFile(bytes, { name, type })
  return t.save(saveArgs())
}

const zip = () =>
  buildZip([
    { name: "docs", dir: true },
    { name: "docs/readme.txt", data: "hello" },
    { name: "image.bin", data: Buffer.alloc(100, 7) },
  ])

/** `count` small files with long names, so that their listing alone is over the budget when there are 500. */
function entries(count: number): ZipEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `entry-${String(i).padStart(3, "0")}-${"n".repeat(100)}.txt`,
    data: "x",
  }))
}

describe("an archive as the file", () => {
  test("a zip is saved whole and listed, not unpacked", async () => {
    const result = await saveArchive("pack.zip", zip(), "application/zip")
    expect(result.files).toHaveLength(1)
    expect(result.files[0]!.archive).toEqual({
      format: "zip",
      files: 2,
      total_size: 105,
      entries: [
        { name: "docs/", size: 0, dir: true },
        { name: "docs/readme.txt", size: 5 },
        { name: "image.bin", size: 100 },
      ],
    })
    expect(result.files[0]!.unpacked).toBeUndefined()
    expect(readdirSync(t.folder)).toEqual(["pack.zip"])
  })

  test("a tar and a gzipped tar are listed too", async () => {
    const tar = buildTar([{ name: "a.txt", data: "abc" }])
    const plain = await saveArchive("pack.tar", tar)
    expect(plain.files[0]!.archive).toMatchObject({ format: "tar", files: 1, total_size: 3 })
    const gz = await saveArchive("pack.tar.gz", gzipSync(tar))
    expect(gz.files[0]!.archive).toMatchObject({ format: "tgz", files: 1, total_size: 3 })
  })

  test("names in the listing are cleaned of invisible characters", async () => {
    const result = await saveArchive("pack.zip", buildZip([{ name: "pay\u200Bment.txt", data: "x" }]))
    expect(result.files[0]!.archive!.entries[0]!.name).toBe("pay?ment.txt")
  })

  test("an empty archive is saved and lists nothing", async () => {
    const result = await saveArchive("empty.zip", buildZip([]))
    expect(result.files[0]!.archive).toEqual({ format: "zip", files: 0, total_size: 0, entries: [] })
  })

  test("an archive saved before is reused, still listed", async () => {
    await saveArchive("pack.zip", zip())
    const again = await t.save(saveArgs())
    expect(again.files[0]).toMatchObject({ already_saved: true, archive: { format: "zip", files: 2 } })
  })

  test("an office document is a file: saved whole, not listed or unpacked", async () => {
    const docx = buildZip([
      { name: "word/document.xml", data: "<w/>" },
      { name: "embedded.zip", data: buildZip([]) },
    ])
    const result = await saveArchive("letter.docx", docx)
    expect(result.files[0]!.archive).toBeUndefined()
    const unpacked = await t.save(saveArgs({ unpack: true }))
    expect(unpacked.files[0]!.unpacked).toBeUndefined()
    expect(existsSync(join(t.folder, "letter.docx.unpacked"))).toBe(false)
  })

  test("a large archive within the limits is saved whole", async () => {
    const big = buildZip([{ name: "zeros.bin", data: Buffer.alloc(2_000_000) }])
    const result = await saveArchive("big.zip", big)
    expect(result.files[0]!.archive).toMatchObject({ format: "zip", files: 1, total_size: 2_000_000 })
    expect(readFileSync(join(t.folder, "big.zip")).length).toBe(big.length)
  })
})

describe("a listing that is too long for the result", () => {
  test("is cut to the first entries of a 500-entry archive, and says so", async () => {
    const result = await saveArchive("big.zip", buildZip(entries(500)))
    const listing = result.files[0]!.archive!
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(RESULT_BUDGET)
    expect(listing.entries_cut).toBe(true)
    expect(listing.entries.length).toBeGreaterThan(100)
    expect(listing.entries.length).toBeLessThan(500)
    expect(listing.entries[0]!.name.startsWith("entry-000-")).toBe(true)
    expect(listing.files).toBe(500)
    expect(listing.total_size).toBe(500)
    expect(readdirSync(t.folder)).toEqual(["big.zip"])
  })

  test("is left whole when it fits", async () => {
    const listing = (await saveArchive("small.zip", buildZip(entries(20)))).files[0]!.archive!
    expect(listing.entries).toHaveLength(20)
    expect(listing.entries_cut).toBeUndefined()
  })
})
