import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createFixtures, type Fixtures } from "../archive/archive.testing"
import { buildZip } from "../archive/zip.testing"
import { abortWhen } from "./abort.testing"
import { unpackArchive } from "./unpack"

let fixtures: Fixtures

beforeEach(() => {
  fixtures = createFixtures()
})
afterEach(() => fixtures.remove())

const zip = () =>
  buildZip([
    { name: "top.txt", data: "top" },
    { name: "docs", dir: true },
    { name: "docs/readme.txt", data: "hello" },
  ])

/** Writes an archive named `name` and returns its folder and path. */
function archive(name: string, bytes: Buffer): { folder: string; archivePath: string } {
  const archivePath = fixtures.write(name, bytes)
  return { folder: archivePath.slice(0, -name.length), archivePath }
}

describe("unpacking midway", () => {
  test("a cancellation removes the staging folder, the private copy and everything written", async () => {
    const { folder, archivePath } = archive("pack.zip", zip())
    // stopped at the first check after a file has been created below the staging folder
    const signal = abortWhen(() =>
      readdirSync(folder).some((name) => name.endsWith(".unpacking") && readdirSync(join(folder, name)).length > 0),
    )
    await expect(unpackArchive({ archivePath, name: "pack.zip", folder, signal })).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(readdirSync(folder)).toEqual(["pack.zip"])
  })

  test("stops in the middle of a large entry, between two chunks of its data", async () => {
    const big = buildZip([{ name: "big.bin", data: Buffer.alloc(3_000_000, 0x61), method: "stored" }])
    const { folder, archivePath } = archive("big.zip", big)
    let sizeWhenStopped = -1
    const signal = abortWhen(() => {
      const staging = readdirSync(folder).find((name) => name.endsWith(".unpacking"))
      if (staging === undefined || !existsSync(join(folder, staging, "big.bin"))) return false
      sizeWhenStopped = statSync(join(folder, staging, "big.bin")).size
      return sizeWhenStopped > 0
    })
    await expect(unpackArchive({ archivePath, name: "big.zip", folder, signal })).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(sizeWhenStopped).toBeGreaterThan(0)
    expect(sizeWhenStopped).toBeLessThan(3_000_000)
    expect(readdirSync(folder)).toEqual(["big.zip"])
  })

  test("an archive that is not one any more is refused, leaving only the archive", async () => {
    const { folder, archivePath } = archive("pack.zip", Buffer.from("no longer an archive"))
    await expect(unpackArchive({ archivePath, name: "pack.zip", folder })).rejects.toThrow()
    expect(readdirSync(folder)).toEqual(["pack.zip"])
  })

  test("unpacks the same archive when nothing stops it", async () => {
    const { folder, archivePath } = archive("pack.zip", zip())
    const unpacked = await unpackArchive({ archivePath, name: "pack.zip", folder })
    expect(unpacked.alreadyUnpacked).toBe(false)
    expect(readdirSync(folder).sort()).toEqual(["pack.zip", "pack.zip.unpacked"])
  })
})

describe("publishing the unpacked folder", () => {
  test("never replaces what has been put in the folder meanwhile: the next name is taken", async () => {
    const { folder, archivePath } = archive("pack.zip", zip())
    const targets: string[] = []
    const beforeRename = (target: string) => {
      targets.push(target)
      // someone fills the folder that was just made, after it was made and before the rename
      if (targets.length === 1) writeFileSync(join(target, "theirs.txt"), "not ours")
    }

    const unpacked = await unpackArchive({ archivePath, name: "pack.zip", folder, beforeRename })

    expect(targets.map((target) => target.replace(folder, ""))).toEqual(["pack.zip.unpacked", "pack.zip (2).unpacked"])
    expect(unpacked.path).toBe(join(folder, "pack.zip (2).unpacked"))
    expect(readFileSync(join(folder, "pack.zip.unpacked", "theirs.txt"), "utf8")).toBe("not ours")
    expect(readdirSync(join(folder, "pack.zip (2).unpacked")).sort()).toEqual(["docs", "top.txt"])
    expect(readdirSync(folder).filter((name) => name.startsWith("."))).toEqual([])
  })

  test("removes the folder it made again when it is still empty and the rename fails", async () => {
    const { folder, archivePath } = archive("pack.zip", zip())
    const boom = new Error("rename would have failed")
    const beforeRename = () => {
      throw boom
    }
    await expect(unpackArchive({ archivePath, name: "pack.zip", folder, beforeRename })).rejects.toBe(boom)
    expect(readdirSync(folder)).toEqual(["pack.zip"])
  })

  test("makes the folder itself, so a name that is taken in any form is never replaced", async () => {
    const { folder, archivePath } = archive("pack.zip", zip())
    writeFileSync(join(folder, "pack.zip.unpacked"), "a file")
    symlinkSync(join(folder, "elsewhere"), join(folder, "pack.zip (2).unpacked"))
    const unpacked = await unpackArchive({ archivePath, name: "pack.zip", folder })
    expect(unpacked.path).toBe(join(folder, "pack.zip (3).unpacked"))
    expect(readFileSync(join(folder, "pack.zip.unpacked"), "utf8")).toBe("a file")
  })
})
