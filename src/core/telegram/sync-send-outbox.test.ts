import {
  appendFileSync,
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { makeTempDir } from "./mirror.testing"
import { SEND_FILES_MAX_BYTES } from "./service-requests"
import { withOutboxFiles, type OutboxFile } from "./sync-send-outbox"

let outbox: string

beforeEach(() => {
  outbox = join(makeTempDir(), "outbox")
  mkdirSync(outbox)
})

afterEach(() => rmSync(join(outbox, ".."), { recursive: true, force: true }))

const put = (name: string, content: string) => {
  const path = join(outbox, name)
  writeFileSync(path, content)
  return { path, name }
}

async function textOf(file: OutboxFile): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of file.stream()) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString()
}

describe("the files of a send", () => {
  test("are read from the descriptor that was checked, not from the path", async () => {
    const file = put("a.txt", "checked bytes")

    const text = await withOutboxFiles(outbox, [file], async ([opened]) => {
      renameSync(put("b.txt", "swapped in").path, file.path)
      return textOf(opened!)
    })

    expect(text).toBe("checked bytes")
  })

  test("give no more than the bytes they had when checked, though the file grows", async () => {
    const file = put("a.txt", "checked")

    const text = await withOutboxFiles(outbox, [file], async ([opened]) => {
      appendFileSync(file.path, " and then some")
      return textOf(opened!)
    })

    expect(text).toBe("checked")
  })

  test("are closed once the work is done, and when it fails", async () => {
    const file = put("a.txt", "bytes")
    let kept: OutboxFile | undefined
    await withOutboxFiles(outbox, [file], async ([opened]) => void (kept = opened))
    await expect(textOf(kept!)).rejects.toThrow()

    await expect(
      withOutboxFiles(outbox, [file], async ([opened]) => {
        kept = opened
        throw new Error("the upload failed")
      }),
    ).rejects.toThrow("the upload failed")
    await expect(textOf(kept!)).rejects.toThrow()
  })

  test("are closed when a later file is refused", async () => {
    const files = [put("a.txt", "bytes"), { path: join(outbox, "missing.txt"), name: "missing.txt" }]
    let opened = 0

    await expect(withOutboxFiles(outbox, files, async () => void opened++)).rejects.toMatchObject({
      code: "invalid_argument",
    })
    expect(opened).toBe(0)
  })

  test("may be exactly the most bytes together, and not one more", async () => {
    const sparse = (name: string, size: number) => {
      const file = put(name, "")
      const fd = openSync(file.path, "r+")
      ftruncateSync(fd, size)
      closeSync(fd)
      return file
    }
    const half = SEND_FILES_MAX_BYTES / 2
    const within = [sparse("one.bin", half), sparse("two.bin", half)]

    expect(await withOutboxFiles(outbox, within, async (opened) => opened.map((file) => file.size))).toEqual([
      half,
      half,
    ])

    const over = [sparse("three.bin", half), sparse("four.bin", half + 1)]
    await expect(withOutboxFiles(outbox, over, async () => {})).rejects.toMatchObject({ code: "invalid_argument" })
  })
})
