import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { linkSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ELF_BYTES } from "../../archive/archive.testing"
import { buildZip } from "../../archive/zip.testing"
import type { ServiceCalls } from "../../chat/read.testing"
import { fakeKey } from "../../outgoing/outgoing.testing"
import { canMakeFifo, makeFifo } from "./fifo.testing"
import { createFileSendFixture, type FileSendFixture } from "./tool.testing"

let t: FileSendFixture
let calls: ServiceCalls

beforeEach(async () => {
  t = createFileSendFixture()
  calls = (await t.serveFiles()).calls
})

afterEach(async () => {
  await t.close()
})

/** Calls the tool with the files, which must fail with `code` before anything is sent or left behind. */
async function refused(files: Array<{ path: string; sha256?: string }>, code: string, extra: object = {}) {
  const error = await t.filesFailure({ files, ...extra })
  expect(error).toMatchObject({ code })
  expect(calls).toHaveLength(0)
  expect(t.outboxEntries()).toEqual([])
  return error
}

/** A made-up file outside the working directory, in a folder of its own. */
function outsideFile(): string {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "send-outside-")))
  const path = join(outside, "plain.txt")
  writeFileSync(path, "x")
  return path
}

describe("file send: where a file may come from", () => {
  test("a path in the working directory is sent", async () => {
    const path = t.write("inside.txt")
    expect((await t.sendFiles({ files: [{ path: "inside.txt" }] })).files[0]!.path).toBe(path)
  })

  test("a path outside the working directory is refused, saying how to allow it", async () => {
    const error = await refused([{ path: outsideFile() }], "forbidden")
    expect(error.message).toContain("send_dirs")
  })

  test("a path outside through a link, and one that climbs out with .., is refused", async () => {
    const outside = outsideFile()
    symlinkSync(outside, join(t.work, "link.txt"))
    await refused([{ path: "link.txt" }], "forbidden")
    await refused([{ path: `../${outside.split("/").slice(-2).join("/")}` }], "forbidden")
  })

  test("a path in a send directory is sent once the context names it", async () => {
    const outside = outsideFile()
    const result = await t.sendFiles({ files: [{ path: outside }] }, { sendDirs: [join(outside, "..")] })
    expect(result.files[0]!.path).toBe(outside)
  })

  test("a working directory that is a file system root does not count", async () => {
    const error = await t.filesFailure({ files: [{ path: outsideFile() }] }, { cwd: "/" })
    expect(error).toMatchObject({ code: "forbidden" })
    expect(error.message).toContain("send_dirs")
    expect(calls).toHaveLength(0)
  })

  test("a file in the state directory, though a send directory is above it", async () => {
    const error = await t.filesFailure(
      { files: [{ path: t.paths.mirror }] },
      { cwd: t.stateDir, sendDirs: [t.stateDir] },
    )
    expect(error).toMatchObject({ code: "forbidden" })
    expect(error.message).not.toContain("send_dirs")
    expect(calls).toHaveLength(0)
  })

  test("a file in the tools' own directory", async () => {
    const own = outsideFile()
    const error = await t.filesFailure(
      { files: [{ path: own }] },
      { sendDirs: [join(own, "..")], ownDir: join(own, "..") },
    )
    expect(error).toMatchObject({ code: "forbidden" })
    expect(calls).toHaveLength(0)
  })
})

describe("file send: files that are refused before anything is sent", () => {
  test("a file that does not exist", async () => {
    await refused([{ path: "missing.txt" }], "not_found")
  })

  test("a name that looks like a key or a secret, and a key folder", async () => {
    await refused([{ path: t.write(".env", "A=1\n") }], "forbidden")
    await refused([{ path: t.write("keys/server.pem", "x") }], "forbidden")
    await refused([{ path: t.write(".ssh/config", "x") }], "forbidden")
  })

  test("a private key inside a file with an innocent name, naming the file as given", async () => {
    t.write("notes.txt", `before\n${fakeKey("RSA ")}`)
    const error = await refused([{ path: "notes.txt" }], "forbidden")
    expect(error.message).toBe('"notes.txt" cannot be sent: it is a private key.')
  })

  test("a program under an innocent name", async () => {
    t.write("notes.txt", ELF_BYTES)
    const error = await refused([{ path: "notes.txt" }], "forbidden")
    expect(error.message).toBe('"notes.txt" cannot be sent: it is a program.')
  })

  test("an empty file", async () => {
    t.write("empty.txt", "")
    const error = await refused([{ path: "empty.txt" }], "forbidden")
    expect(error.message).toContain("it is an empty file")
  })

  test("an archive with an entry that may not leave, naming the entry", async () => {
    t.write(
      "bundle.zip",
      buildZip([
        { name: "ok.txt", data: "fine" },
        { name: "app/.env", data: "A=1\n" },
      ]),
    )
    const error = await refused([{ path: "bundle.zip" }], "forbidden")
    expect(error.message).toBe('"bundle.zip" cannot be sent: the entry app/.env is named like a key or a secret.')
  })

  test("a hard link, whose other name could be anywhere", async () => {
    linkSync(t.write(".ssh/notes.txt"), join(t.work, "innocent.txt"))
    await refused([{ path: "innocent.txt" }], "forbidden")
  })

  test("the same file twice, by the same path or by a link to it, naming the second path as given", async () => {
    const path = t.write("a.txt")
    symlinkSync(path, join(t.work, "again.txt"))
    const error = await refused([{ path }, { path: "again.txt" }], "invalid_argument")
    expect(error.message).toContain('"again.txt"')
    await refused([{ path: "a.txt" }, { path: "./a.txt" }], "invalid_argument")
  })

  test.skipIf(!canMakeFifo())("a FIFO is not a file, and the call does not wait for a writer", async () => {
    makeFifo(join(t.work, "pipe"))
    const started = Date.now()
    await refused([{ path: "pipe" }], "invalid_argument")
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test("a folder is not a file", async () => {
    mkdirSync(join(t.work, "folder"))
    await refused([{ path: "folder" }], "invalid_argument")
  })

  test("a refused file among good ones stops all of them", async () => {
    await refused([{ path: t.write("a.txt") }, { path: t.write(".env") }, { path: t.write("c.txt") }], "forbidden")
  })
})
