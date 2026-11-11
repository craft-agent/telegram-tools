import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { buildTar } from "../archive/tar.testing"
import { buildZip } from "../archive/zip.testing"
import { modeOf as mode } from "../telegram/sync-keep.testing"
import { CANCELLED_MESSAGE } from "./constants"
import { abortWhen } from "./abort.testing"
import { createSaveFixture, saveArgs, type SaveFixture } from "./save.testing"

let t: SaveFixture

beforeEach(() => {
  t = createSaveFixture()
})
afterEach(() => t.close())

const zip = () =>
  buildZip([
    { name: "top.txt", data: "top" },
    { name: "docs", dir: true },
    { name: "docs/readme.txt", data: "hello" },
    { name: "deep/er/data.bin", data: Buffer.from([1, 2, 3]) },
    { name: "empty-dir", dir: true },
  ])

async function saveWith(bytes: Buffer, name = "pack.zip", extra: Record<string, unknown> = { unpack: true }) {
  await t.serveFile(bytes, { name })
  return t.save(saveArgs(extra))
}

const leftovers = (folder: string) => readdirSync(folder).filter((name) => name.startsWith("."))

/** Every path below a folder, folders with a trailing slash. */
function tree(root: string, prefix = ""): string[] {
  return readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) =>
      entry.isDirectory()
        ? [`${prefix}${entry.name}/`, ...tree(join(root, entry.name), `${prefix}${entry.name}/`)]
        : [`${prefix}${entry.name}`],
    )
}

describe("unpacking a saved archive", () => {
  test("writes the tree beside the archive, folders 0700 and files 0600", async () => {
    const result = await saveWith(zip())
    const target = join(t.folder, "pack.zip.unpacked")
    expect(result.files[0]!.unpacked).toBe(target)
    expect(result.files[0]!.already_unpacked).toBeUndefined()
    expect(tree(target)).toEqual([
      "deep/",
      "deep/er/",
      "deep/er/data.bin",
      "docs/",
      "docs/readme.txt",
      "empty-dir/",
      "top.txt",
    ])
    expect(readFileSync(join(target, "docs", "readme.txt"), "utf8")).toBe("hello")
    expect([...readFileSync(join(target, "deep", "er", "data.bin"))]).toEqual([1, 2, 3])
    for (const folder of [target, join(target, "deep"), join(target, "deep", "er"), join(target, "empty-dir")]) {
      expect(mode(folder)).toBe(0o700)
    }
    for (const file of ["top.txt", "docs/readme.txt", "deep/er/data.bin"]) expect(mode(join(target, file))).toBe(0o600)
    expect(leftovers(t.folder)).toEqual([])
    expect(readdirSync(t.folder).sort()).toEqual(["pack.zip", "pack.zip.unpacked"])
    expect(t.incomingNames()).toEqual([])
  })

  test("unpacks a gzipped tar, and an empty archive into an empty folder", async () => {
    const tgz = await saveWith(gzipSync(buildTar([{ name: "a/b.txt", data: "in a tar" }])), "bundle.tar.gz")
    expect(readFileSync(join(tgz.files[0]!.unpacked!, "a", "b.txt"), "utf8")).toBe("in a tar")
    const empty = await saveWith(buildZip([]), "nothing.zip")
    expect(tree(empty.files[0]!.unpacked!)).toEqual([])
  })

  test("is only done when asked for", async () => {
    await saveWith(zip(), "pack.zip", {})
    await saveWith(zip(), "pack.zip", { unpack: false })
    expect(readdirSync(t.folder)).toEqual(["pack.zip"])
  })

  test("a second call with unpack finds the folder and writes nothing", async () => {
    const first = await saveWith(zip())
    const target = first.files[0]!.unpacked!
    writeFileSync(join(target, "mine.txt"), "added by the user")
    const before = tree(t.folder)

    const second = await t.save(saveArgs({ unpack: true }))

    expect(second.files[0]).toMatchObject({ already_saved: true, unpacked: target, already_unpacked: true })
    expect(tree(t.folder)).toEqual(before)
    expect(readFileSync(join(target, "mine.txt"), "utf8")).toBe("added by the user")
  })

  test("a second call with unpack unpacks an archive the first call only saved", async () => {
    await saveWith(zip(), "pack.zip", {})
    const second = await t.save(saveArgs({ unpack: true }))
    expect(second.files[0]).toMatchObject({ already_saved: true, unpacked: join(t.folder, "pack.zip.unpacked") })
    expect(tree(join(t.folder, "pack.zip.unpacked"))).toContain("docs/readme.txt")
  })

  test("what is in the way of the unpacked folder is never touched or followed: the folder is numbered", async () => {
    mkdirSync(t.folder, { recursive: true })
    const outside = join(t.downloadDir, "outside")
    mkdirSync(outside)
    writeFileSync(join(t.folder, "pack.zip.unpacked"), "in the way")
    symlinkSync(outside, join(t.folder, "pack.zip (2).unpacked"))

    const result = await saveWith(zip())

    expect(result.files[0]!.unpacked).toBe(join(t.folder, "pack.zip (3).unpacked"))
    expect(readFileSync(join(t.folder, "pack.zip.unpacked"), "utf8")).toBe("in the way")
    expect(readdirSync(outside)).toEqual([])
  })

  test("unpack on a file that is not an archive saves it and unpacks nothing", async () => {
    await t.serveFile("plain text", { name: "notes.txt" })
    const result = await t.save(saveArgs({ unpack: true }))
    expect(result.files).toMatchObject([{ name: "notes.txt" }])
    expect(result.files[0]!.unpacked).toBeUndefined()
    expect(result.errors).toBeUndefined()
    expect(readdirSync(t.folder)).toEqual(["notes.txt"])
  })

  test("a hostile archive is refused before it can be unpacked", async () => {
    const result = await saveWith(buildZip([{ name: "../out.txt", data: "x" }]))
    expect(result.files).toEqual([])
    expect(result.refused).toHaveLength(1)
    expect(readdirSync(t.downloadDir)).toEqual([])
  })
})

describe("an unpack that fails", () => {
  const boom = () => Promise.reject(new Error("disk is full"))

  test("is listed under errors.unpack:<name> with no detail it cannot vouch for, and the archive stays saved", async () => {
    await t.serveFile(zip(), { name: "pack.zip" })
    const result = await t.save(saveArgs({ unpack: true }), { host: { unpack: boom } })
    expect(result.files[0]).toMatchObject({ name: "pack.zip" })
    expect(result.files[0]!.unpacked).toBeUndefined()
    expect(result.errors).toEqual({ "unpack:pack.zip": "failed" })
    expect(readdirSync(t.folder)).toEqual(["pack.zip"])
  })

  test("an error that is not ours says only its code, never a path", async () => {
    await t.serveFile(zip(), { name: "pack.zip" })
    const enospc = () => Promise.reject(Object.assign(new Error(`ENOSPC at ${t.stateDir}`), { code: "ENOSPC" }))
    const result = await t.save(saveArgs({ unpack: true }), { host: { unpack: enospc } })
    expect(result.errors).toEqual({ "unpack:pack.zip": "failed (ENOSPC)" })
  })

  test("a cancellation during unpacking leaves the archive saved, nothing half unpacked, and says so", async () => {
    await t.serveFile(zip(), { name: "pack.zip" })
    // cancelled as soon as unpacking has written something below its staging folder
    const signal = abortWhen(
      () =>
        existsSync(t.folder) &&
        readdirSync(t.folder).some(
          (name) => name.endsWith(".unpacking") && readdirSync(join(t.folder, name)).length > 0,
        ),
    )

    const result = await t.save(saveArgs({ unpack: true }), { host: { platform: "darwin" }, ctx: { signal } })

    expect(result.files.map((file) => [file.name, file.unpacked])).toEqual([["pack.zip", undefined]])
    expect(result.errors).toEqual({ cancelled: CANCELLED_MESSAGE })
    expect(readdirSync(t.folder)).toEqual(["pack.zip"])
    expect(t.runs).toHaveLength(1)
    expect(t.incomingNames()).toEqual([])
  })
})
