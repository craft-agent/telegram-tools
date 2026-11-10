import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import type { ServiceCalls } from "../../chat/read.testing"
import { SEND_FILES_MAX } from "../../telegram/service-requests"
import { createFileSendFixture, type FileSendFixture } from "./tool.testing"
import { createFileSend } from "./tool"

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
async function refused(files: Array<{ path: string; sha256?: string }>, code: string) {
  const error = await t.filesFailure({ files })
  expect(error).toMatchObject({ code })
  expect(calls).toHaveLength(0)
  expect(t.outboxEntries()).toEqual([])
  return error
}

describe("file send: sha256", () => {
  const sha = (content: string) => createHash("sha256").update(content).digest("hex")

  test("a file that matches is sent, whatever case the digest is written in", async () => {
    const path = t.write("a.txt", "approved\n")
    await t.sendFiles({ files: [{ path, sha256: sha("approved\n") }] })
    await t.sendFiles({ files: [{ path, sha256: sha("approved\n").toUpperCase() }] })
    expect(calls).toHaveLength(2)
  })

  test("a file that differs is stale, naming the path as given, and nothing is sent", async () => {
    t.write("a.txt", "changed since\n")
    const error = await refused([{ path: "a.txt", sha256: sha("approved\n") }], "stale")
    expect(error.message).toBe('"a.txt" is not the file that was approved: its SHA-256 differs.')
  })

  test("a digest that is not 64 hexadecimal digits is invalid_argument", async () => {
    const path = t.write("a.txt")
    for (const sha256 of ["abc", "g".repeat(64), "a".repeat(63)]) {
      await refused([{ path, sha256 }], "invalid_argument")
    }
  })

  test("one file that differs among several stops the whole send", async () => {
    await refused([{ path: t.write("a.txt") }, { path: t.write("b.txt"), sha256: "f".repeat(64) }], "stale")
  })
})

describe("file send: what a send takes", () => {
  test("more files than a send carries, or none, is invalid_argument", async () => {
    const files = Array.from({ length: SEND_FILES_MAX + 1 }, (_, i) => ({ path: t.write(`f${i}.txt`, String(i)) }))
    await refused(files, "invalid_argument")
    await refused([], "invalid_argument")
    const result = await t.sendFiles({ files: files.slice(0, SEND_FILES_MAX) })
    expect(result.files).toHaveLength(SEND_FILES_MAX)
    expect(calls).toHaveLength(1)
  })

  test("more bytes than the limit is invalid_argument, counted over all the files, and nothing is sent", async () => {
    const small = createFileSend({ maxTotalBytes: 100 })
    const files = [{ path: t.write("a.txt", "x".repeat(60)) }, { path: t.write("b.txt", "y".repeat(60)) }]
    const error = await t.filesFailure({ files }, {}, small)
    expect(error).toMatchObject({ code: "invalid_argument" })
    expect(error.message).toContain("100 bytes")
    expect(calls).toHaveLength(0)
    expect(t.outboxEntries()).toEqual([])
    expect(await t.sendFiles({ files: files.slice(0, 1) }, {}, small)).toMatchObject({ files: [{ size: 60 }] })
  })

  test("the limit is told in megabytes when it is whole megabytes", async () => {
    const small = createFileSend({ maxTotalBytes: 1024 * 1024 })
    const error = await t.filesFailure(
      { files: [{ path: t.write("big.txt", "x".repeat(1024 * 1024 + 1)) }] },
      {},
      small,
    )
    expect(error).toMatchObject({ code: "invalid_argument" })
    expect(error.message).toContain("over 1 MB")
  })
})
