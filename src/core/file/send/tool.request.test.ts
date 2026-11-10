import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { basename } from "node:path"
import { OTHER_USER, SUPERGROUP, USER } from "../../telegram/mirror.testing"
import { CAPTION_MAX_UNITS, GENERAL_TOPIC, SEND_FILES_MAX, SEND_FILES_MAX_BYTES } from "../../telegram/service-requests"
import { MAX_FILES, MAX_TOTAL_BYTES } from "../../outgoing/limits"
import { SEND_FILES_TIMEOUT_MS } from "./constants"
import { createFileSendFixture, type FileSendFixture } from "./tool.testing"

let t: FileSendFixture

beforeEach(() => {
  t = createFileSendFixture()
})

afterEach(async () => {
  await t.close()
})

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex")

describe("file send: the request", () => {
  test("asks what the service takes: the same most as the rules", () => {
    expect(MAX_FILES).toBe(SEND_FILES_MAX)
    expect(MAX_TOTAL_BYTES).toBe(SEND_FILES_MAX_BYTES)
  })

  test("sends the chat, the private copy with its name and the trimmed caption, as a write", async () => {
    const path = t.write("notes/today.txt", "hello\n")
    const { calls, seen } = await t.serveFiles()
    await t.sendFiles({ files: [{ path }], caption: "  here you go \n" })
    expect(calls).toEqual([
      {
        method: "send_files",
        params: { chat: USER, files: [{ path: seen[0]!.path, name: "today.txt" }], caption: "here you go" },
      },
    ])
  })

  test("sends the caption as written: Markdown and HTML stay as they are", async () => {
    const { calls } = await t.serveFiles()
    const caption = "*bold* _it_ `code` <b>x</b> [a](https://example.test)"
    await t.sendFiles({ files: [{ path: t.write("a.txt") }], caption })
    expect((calls[0]?.params as { caption: string }).caption).toBe(caption)
  })

  test("the copy is private, in the outbox, named as the file is, with the file's bytes", async () => {
    const path = t.write("report.pdf", "%PDF made up\n")
    const { seen } = await t.serveFiles()
    await t.sendFiles({ files: [{ path }] })
    const [copy] = seen
    expect(copy!.path.startsWith(`${t.paths.outbox}/`)).toBe(true)
    expect(basename(copy!.path)).toBe("report.pdf")
    expect(copy!.path).not.toBe(path)
    expect(copy!.content.toString()).toBe("%PDF made up\n")
    expect(copy!.mode).toBe(0o600)
    expect(copy!.folderMode).toBe(0o700)
  })

  test("without a caption, or with a blank one, none is sent", async () => {
    const path = t.write("a.txt")
    const { calls } = await t.serveFiles()
    await t.sendFiles({ files: [{ path }] })
    await t.sendFiles({ files: [{ path }], caption: " \n " })
    expect(calls).toHaveLength(2)
    for (const { params } of calls) expect(params).not.toHaveProperty("caption")
  })

  test("sends the topic and the reply when given, and nothing else", async () => {
    const path = t.write("a.txt")
    const { calls } = await t.serveFiles()
    await t.sendFiles({ chat: SUPERGROUP, files: [{ path }], topic: 12, reply_to: 345 })
    await t.sendFiles({ chat: SUPERGROUP, files: [{ path }], topic: GENERAL_TOPIC })
    await t.sendFiles({ chat: OTHER_USER, files: [{ path }], reply_to: 9 })
    expect(calls.map(({ params }) => Object.keys(params as object))).toEqual([
      ["chat", "files", "topic", "reply_to"],
      ["chat", "files", "topic"],
      ["chat", "files", "reply_to"],
    ])
    expect(calls.map(({ params }) => (params as { chat: string }).chat)).toEqual([SUPERGROUP, SUPERGROUP, OTHER_USER])
  })

  test("several files go as one send, in the order given, each in a folder of its own", async () => {
    const first = t.write("one/a.txt", "1")
    const second = t.write("two/a.txt", "22")
    const { calls, seen } = await t.serveFiles()
    const result = await t.sendFiles({ files: [{ path: first }, { path: second }] })
    expect(calls).toHaveLength(1)
    expect(seen.map((copy) => copy.content.toString())).toEqual(["1", "22"])
    expect(new Set(seen.map((copy) => copy.path)).size).toBe(2)
    expect(result.files.map((file) => [file.name, file.size])).toEqual([
      ["a.txt", 1],
      ["a.txt", 2],
    ])
  })

  test("a name the service would not take as it is goes out made safe, and names the copy", async () => {
    const { calls, seen } = await t.serveFiles()
    const result = await t.sendFiles({ files: [{ path: t.write(".hidden:name.txt") }, { path: t.write("CON.txt") }] })
    const names = (calls[0]!.params as { files: { name: string }[] }).files.map(({ name }) => name)
    expect(names).toEqual(["_.hidden_name.txt", "_CON.txt"])
    expect(seen.map((copy) => basename(copy.path))).toEqual(names)
    expect(result.files.map((file) => file.name)).toEqual(names)
  })

  test("a relative path is read against the working directory and reported by its real path", async () => {
    const path = t.write("sub/data.csv", "a,b\n")
    await t.serveFiles()
    const result = await t.sendFiles({ files: [{ path: "sub/../sub/data.csv" }] })
    expect(result.files).toEqual([{ path, name: "data.csv", size: 4, sha256: sha256("a,b\n") }])
  })

  test("takes the account's own service", async () => {
    const { calls } = await t.serveFiles()
    await t.sendFiles({ account: "default", files: [{ path: t.write("a.txt") }] })
    expect(calls).toHaveLength(1)
  })

  test("the upload is given the time of a file send, not a text's", async () => {
    await t.serveFiles()
    const timers: number[] = []
    const original = globalThis.setTimeout
    globalThis.setTimeout = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) => {
      if (typeof ms === "number") timers.push(ms)
      return original(handler, ms, ...rest)
    }) as typeof setTimeout
    try {
      await t.sendFiles({ files: [{ path: t.write("a.txt") }] })
    } finally {
      globalThis.setTimeout = original
    }
    expect(timers).toContain(SEND_FILES_TIMEOUT_MS)
  })

  test("a signal already aborted sends nothing and leaves nothing", async () => {
    const { calls } = await t.serveFiles()
    const controller = new AbortController()
    controller.abort()
    await expect(
      t.sendFiles({ files: [{ path: t.write("a.txt") }] }, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(calls).toHaveLength(0)
    expect(t.outboxEntries()).toEqual([])
  })

  test("a caption over the most is refused before anything is copied", async () => {
    await t.serveFiles()
    const error = await t.filesFailure({
      files: [{ path: t.write("a.txt") }],
      caption: "x".repeat(CAPTION_MAX_UNITS + 1),
    })
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain(`${CAPTION_MAX_UNITS + 1} characters`)
    expect(error.message).toContain(`at most ${CAPTION_MAX_UNITS}`)
    expect(t.outboxEntries()).toEqual([])
  })
})
