import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { failureOf } from "./service.testing"
import { CAPTION_MAX_UNITS, SEND_FILES_MAX, type SendFile } from "./service-requests"
import { INT32_MAX } from "./sync-request-params"
import { KEPT } from "./sync-requests.testing"
import { FILE_A, answerFiles, fileCallsOf, outboxFile, sendFiles, writeOutboxFile } from "./sync-send-files.testing"
import { seedSendChats } from "./sync-send.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture
let file: SendFile

beforeAll(async () => {
  fixture = syncFixture()
  seedSendChats(fixture)
  await fixture.running()
  file = outboxFile(fixture, FILE_A)
  answerFiles(fixture, { firstId: 50 })
})

afterAll(() => fixture.close())

const refusal = (params: unknown) => failureOf(sendFiles(fixture, params as Record<string, unknown>))

describe("send_files parameters", () => {
  const ok = () => ({ chat: KEPT, files: [file] })
  const withFile = (change: Record<string, unknown>) => ({ ...ok(), files: [{ ...file, ...change }] })
  const bad: [string, () => unknown][] = [
    ["no parameters", () => undefined],
    ["a list", () => [KEPT]],
    ["no chat", () => ({ files: [file] })],
    ["a chat that is a number", () => ({ ...ok(), chat: 7000000002 })],
    ["no files", () => ({ chat: KEPT })],
    ["files that are not a list", () => ({ ...ok(), files: file })],
    ["an empty list of files", () => ({ ...ok(), files: [] })],
    [
      "one file over the most",
      () => ({ ...ok(), files: Array.from({ length: SEND_FILES_MAX + 1 }, (_, i) => ({ ...file, path: `/${i}` })) }),
    ],
    ["a file that is a string", () => ({ ...ok(), files: [file.path] })],
    ["a file with a field it does not take", () => withFile({ sha256: "00" })],
    ["a file with no path", () => withFile({ path: undefined })],
    ["a relative path", () => withFile({ path: "outbox/notes.txt" })],
    ["a path with a NUL", () => withFile({ path: "/tmp/a\0b" })],
    ["no name", () => withFile({ name: undefined })],
    ["an empty name", () => withFile({ name: "" })],
    ["a name with blank space around it", () => withFile({ name: " notes.txt" })],
    ["a name with a slash", () => withFile({ name: "dir/notes.txt" })],
    ["a name with a NUL", () => withFile({ name: "no\0tes.txt" })],
    ["the name .", () => withFile({ name: "." })],
    ["the name ..", () => withFile({ name: ".." })],
    ["a name of 256 bytes", () => withFile({ name: "a".repeat(256) })],
    ["a name of 128 two-byte characters", () => withFile({ name: "é".repeat(128) })],
    ["the same path twice", () => ({ ...ok(), files: [file, { ...file, name: "other.txt" }] })],
    ["a blank caption", () => ({ ...ok(), caption: "  " })],
    ["a caption with blank space after it", () => ({ ...ok(), caption: "text\n" })],
    ["a caption that is a number", () => ({ ...ok(), caption: 5 })],
    ["a null caption", () => ({ ...ok(), caption: null })],
    ["a caption one unit over the most", () => ({ ...ok(), caption: "a".repeat(CAPTION_MAX_UNITS + 1) })],
    ["an emoji caption one unit over the most", () => ({ ...ok(), caption: `${"😀".repeat(CAPTION_MAX_UNITS / 2)}a` })],
    ["a topic of 0", () => ({ ...ok(), topic: 0 })],
    ["a reply_to past what Telegram numbers", () => ({ ...ok(), reply_to: INT32_MAX + 1 })],
    ["a field it does not take", () => ({ ...ok(), silent: true })],
    ["a field named __proto__", () => Object.fromEntries([...Object.entries(ok()), ["__proto__", 1]])],
  ]

  for (const [name, params] of bad) {
    test(`refuses ${name}`, async () => {
      expect(await refusal(params())).toMatchObject({ code: "invalid_argument" })
      expect(fileCallsOf(fixture)).toEqual([])
      expect(fixture.client.uploads).toEqual([])
    })
  }

  test("never echoes a path, a name or a caption it refuses", async () => {
    const secret = "+15550100123"
    const message = (await refusal({ ...ok(), caption: `${secret} ${"s".repeat(CAPTION_MAX_UNITS)}` })).message
    const named = (await refusal(withFile({ name: `${secret}/x`, path: `/${secret}` }))).message

    expect(message).not.toContain("15550100123")
    expect(named).not.toContain("15550100123")
  })

  test("takes a caption of exactly the most units, though it is half as many characters long as emoji", async () => {
    const caption = "😀".repeat(CAPTION_MAX_UNITS / 2)
    expect(caption.length).toBe(CAPTION_MAX_UNITS)

    expect(await sendFiles(fixture, { ...ok(), caption })).toMatchObject({ messages: [{ id: 50, name: file.name }] })
    expect(fileCallsOf(fixture).at(-1)?.request).toMatchObject({ message: caption })
  })

  test("takes the most files, and a name of exactly 255 bytes", async () => {
    const name = "é".repeat(127) + "a"
    const files = Array.from({ length: SEND_FILES_MAX }, (_, i) => ({
      path: writeOutboxFile(fixture, `many-${i}`, `file ${i}`),
      name: i === 0 ? name : `${i}.txt`,
    }))
    answerFiles(fixture, { firstId: 60 })

    const result = await sendFiles(fixture, { chat: KEPT, files })

    expect(result.messages).toHaveLength(SEND_FILES_MAX)
    expect(result.messages?.[0]).toEqual({ id: 60, name })
  })
})
