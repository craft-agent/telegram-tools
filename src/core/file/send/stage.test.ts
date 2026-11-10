import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { createSandbox, toolFailure, type Sandbox } from "../../outgoing/outgoing.testing"
import { resolveOutgoing } from "../../outgoing/resolve"
import { BYTES_PER_MB } from "../../telegram/service-requests"
import { canMakeFifo, makeFifo } from "./fifo.testing"
import type { ResolvedFile } from "./resolve-files"
import { stageFile } from "./stage"

let box: Sandbox
let work: string
let folder: string

beforeEach(() => {
  box = createSandbox()
  work = box.mkdir("work")
  folder = box.mkdir("outbox/call")
})
afterEach(() => box.remove())

async function resolveFile(path: string, sha256?: string): Promise<ResolvedFile> {
  const resolved = await resolveOutgoing(path, { cwd: work, roots: [work], forbidden: [], home: box.mkdir("home") })
  return { shown: JSON.stringify(path), name: resolved.name, sha256, resolved }
}

const budget = (limit = 1000) => ({ used: 0, limit })

const stage = async (path: string, sha256?: string, limit = 1000) =>
  stageFile(await resolveFile(path, sha256), join(folder, "0"), budget(limit))

describe("stageFile", () => {
  test("copies the file privately under the name it is sent under and reports its size and SHA-256", async () => {
    box.write("work/a.txt", "hello\n")
    const staged = await stageFile(
      { ...(await resolveFile("a.txt")), name: "sent-as.txt" },
      join(folder, "0"),
      budget(),
    )
    expect(staged).toMatchObject({ name: "sent-as.txt", size: 6, path: join(folder, "0", "sent-as.txt") })
    expect(staged.sha256).toBe("5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03")
    expect(readFileSync(staged.path, "utf8")).toBe("hello\n")
    expect(statSync(staged.path).mode & 0o777).toBe(0o600)
    expect(statSync(join(folder, "0")).mode & 0o777).toBe(0o700)
  })

  test("is stale when another file took the path between resolving and opening", async () => {
    const path = box.write("work/a.txt", "approved\n")
    const file = await resolveFile("a.txt")
    renameSync(path, join(work, "aside.txt"))
    writeFileSync(path, "swapped in\n")
    const error = await toolFailure(() => stageFile(file, join(folder, "0"), budget()))
    expect(error.code).toBe("stale")
    expect(error.message).toBe('"a.txt" changed between being checked and being opened; try again.')
  })

  test("is stale when a link took the path, and follows it nowhere", async () => {
    const path = box.write("work/a.txt", "approved\n")
    const other = box.write("work/other.txt", "other\n")
    const file = await resolveFile("a.txt")
    rmSync(path)
    symlinkSync(other, path)
    expect((await toolFailure(() => stageFile(file, folder, budget()))).code).toBe("stale")
  })

  test("is stale when the file is gone", async () => {
    const path = box.write("work/a.txt")
    const file = await resolveFile("a.txt")
    rmSync(path)
    expect((await toolFailure(() => stageFile(file, folder, budget()))).code).toBe("stale")
  })

  test("is forbidden when the file gained another name since it was resolved", async () => {
    const path = box.write("work/a.txt")
    const file = await resolveFile("a.txt")
    linkSync(path, join(work, "second-name.txt"))
    expect((await toolFailure(() => stageFile(file, folder, budget()))).code).toBe("forbidden")
  })

  test("is stale when the bytes differ from the digest that was approved, in any case when they match", async () => {
    box.write("work/a.txt", "hello\n")
    expect((await toolFailure(() => stage("a.txt", "0".repeat(64)))).code).toBe("stale")
    const upper = "5891B5B522D5DF086D0FF0B110FBD9D21BB4FC7163AF34D08286A2E846F6BE03"
    const staged = await stageFile(await resolveFile("a.txt", upper), join(folder, "1"), budget())
    expect(staged.size).toBe(6)
  })

  test("counts its bytes against the budget of the whole send, refusing the file that passes the limit", async () => {
    box.write("work/a.txt", "x".repeat(60))
    box.write("work/b.txt", "y".repeat(60))
    const shared = budget(100)
    await stageFile(await resolveFile("a.txt"), join(folder, "0"), shared)
    expect(shared.used).toBe(60)
    const error = await toolFailure(async () => stageFile(await resolveFile("b.txt"), join(folder, "1"), shared))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("100 bytes")
  })

  test("tells the limit in megabytes when it is whole megabytes", async () => {
    box.write("work/a.txt", "x")
    const error = await toolFailure(async () =>
      stageFile(await resolveFile("a.txt"), join(folder, "0"), { used: BYTES_PER_MB * 100, limit: BYTES_PER_MB * 100 }),
    )
    expect(error.message).toContain("100 MB")
  })

  test.skipIf(!canMakeFifo())(
    "ends at once for a FIFO put where the file was, instead of waiting for a writer",
    async () => {
      const path = box.write("work/a.txt")
      const file = await resolveFile("a.txt")
      rmSync(path)
      makeFifo(path)
      const started = Date.now()
      const error = await toolFailure(() => stageFile(file, join(folder, "0"), budget()))
      expect(Date.now() - started).toBeLessThan(2000)
      expect(error.code).toBe("invalid_argument")
      expect(error.message).toBe('"a.txt" is not a regular file.')
      expect(existsSync(join(folder, "0", "a.txt"))).toBe(false)
    },
  )

  test("stops with the signal's reason part-way through", async () => {
    box.write("work/big.bin", "x".repeat(1024 * 1024))
    const file = await resolveFile("big.bin")
    const reason = new Error("stopped")
    const controller = new AbortController()
    controller.abort(reason)
    await expect(stageFile(file, join(folder, "0"), budget(10 * BYTES_PER_MB), controller.signal)).rejects.toBe(reason)
  })

  test("never writes through a link where its folder belongs", async () => {
    box.write("work/a.txt")
    mkdirSync(box.mkdir("elsewhere"), { recursive: true })
    symlinkSync(join(box.root, "elsewhere"), join(folder, "0"))
    await expect(stage("a.txt")).rejects.toThrow()
    expect(existsSync(join(box.root, "elsewhere", "a.txt"))).toBe(false)
  })
})
