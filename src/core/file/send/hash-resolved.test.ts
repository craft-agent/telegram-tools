import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { renameSync, rmSync, writeFileSync } from "node:fs"
import { open } from "node:fs/promises"
import { join } from "node:path"
import { createSandbox, toolFailure, type Sandbox } from "../../outgoing/outgoing.testing"
import { resolveOutgoing } from "../../outgoing/resolve"
import { canMakeFifo, makeFifo } from "./fifo.testing"
import { hashResolved } from "./hash-resolved"
import type { ResolvedFile } from "./resolve-files"

let box: Sandbox
let work: string

beforeEach(() => {
  box = createSandbox()
  work = box.mkdir("work")
})
afterEach(() => box.remove())

async function resolveFile(path: string): Promise<ResolvedFile> {
  const resolved = await resolveOutgoing(path, { cwd: work, roots: [work], forbidden: [], home: box.mkdir("home") })
  return { shown: JSON.stringify(path), name: resolved.name, sha256: undefined, resolved }
}

const budget = (limit = 1000) => ({ used: 0, limit })

describe("hashResolved", () => {
  test("reports the size and SHA-256 of the file and counts the size against the budget", async () => {
    box.write("work/a.txt", "hello\n")
    const shared = budget()
    expect(await hashResolved(await resolveFile("a.txt"), shared)).toEqual({
      size: 6,
      sha256: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
    })
    expect(shared.used).toBe(6)
  })

  test("rejects with the signal's reason part-way through, and closes the file", async () => {
    box.write("work/big.bin", "x".repeat(1024 * 1024))
    const file = await resolveFile("big.bin")
    const probe = await open(join(work, "big.bin"))
    const close = spyOn(Object.getPrototypeOf(probe), "close")
    await probe.close()
    close.mockClear()
    const reason = new Error("stopped")
    const controller = new AbortController()
    controller.abort(reason)
    await expect(hashResolved(file, budget(10 * 1024 * 1024), controller.signal)).rejects.toBe(reason)
    expect(close).toHaveBeenCalled()
    close.mockRestore()
  })

  test("is stale when another file took the path since it was resolved", async () => {
    const path = box.write("work/a.txt", "approved\n")
    const file = await resolveFile("a.txt")
    renameSync(path, join(work, "aside.txt"))
    writeFileSync(path, "swapped in\n")
    expect((await toolFailure(() => hashResolved(file, budget()))).code).toBe("stale")
  })

  test.skipIf(!canMakeFifo())("refuses a FIFO put where the file was, without waiting for a writer", async () => {
    const path = box.write("work/a.txt")
    const file = await resolveFile("a.txt")
    rmSync(path)
    makeFifo(path)
    const error = await toolFailure(() => hashResolved(file, budget()))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toBe('"a.txt" is not a regular file.')
  })

  test("refuses a file that cannot fit in what is left of the budget, before reading it", async () => {
    box.write("work/a.txt", "x".repeat(60))
    const shared = { used: 50, limit: 100 }
    const error = await toolFailure(async () => hashResolved(await resolveFile("a.txt"), shared))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("100 bytes")
    expect(shared.used).toBe(50)
  })

  test("shares the budget across the files it is given", async () => {
    box.write("work/a.txt", "x".repeat(60))
    box.write("work/b.txt", "y".repeat(60))
    const shared = budget(100)
    await hashResolved(await resolveFile("a.txt"), shared)
    const error = await toolFailure(async () => hashResolved(await resolveFile("b.txt"), shared))
    expect(error.code).toBe("invalid_argument")
  })

  test("uses the same digest as a plain hash", async () => {
    const content = "abc".repeat(100_000)
    box.write("work/a.txt", content)
    const digest = await hashResolved(await resolveFile("a.txt"), budget(1_000_000))
    expect(digest.sha256).toBe(createHash("sha256").update(content).digest("hex"))
  })
})
