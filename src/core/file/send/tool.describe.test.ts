import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { callDescription, wholeCallDescription } from "../../describe"
import { upsertTopics } from "../../telegram/ingest-chats"
import { OTHER_USER, SUPERGROUP, USER } from "../../telegram/mirror.testing"
import { CAPTION_MAX_UNITS } from "../../telegram/service-requests"
import { createFileSendFixture, type FileSendFixture } from "./tool.testing"
import { createFileSend, telegramFileSend } from "./tool"

let t: FileSendFixture

beforeEach(() => {
  t = createFileSendFixture()
  t.known({ id: USER, kind: "user", name: "Alice Example" })
})

afterEach(async () => {
  await t.close()
})

const describeCall = (args: object, tool = telegramFileSend) =>
  callDescription(tool, { chat: USER, ...args }, t.context())

const sha256 = (content: string) => createHash("sha256").update(content).digest("hex")

describe("file send: the approval description", () => {
  test("states the intent", () => {
    expect(telegramFileSend.intent).toBe("About to send files")
  })

  test("one file to a person: names the file and the person, the kind of chat and the size, and pins the content", async () => {
    const path = t.write("report.txt", "twelve bytes")
    expect(await describeCall({ files: [{ path: "report.txt" }] })).toEqual({
      headline: { text: "About to send {file} to {chat}", values: { file: "report.txt", chat: "Alice Example" } },
      facts: [
        { label: "Chat", value: { text: "Person" } },
        { label: "Size", value: { text: "{bytes} bytes", values: { bytes: 12 } } },
      ],
      pins: { [`sha256:${path}`]: sha256("twelve bytes") },
    })
  })

  test("several files: the files headline, the count and the total size, and a pin for each", async () => {
    t.known({ id: SUPERGROUP, kind: "supergroup", name: "Old Friends", username: null })
    const first = t.write("a.txt", "abc")
    const second = t.write("b.txt", "defgh")
    expect(await describeCall({ chat: SUPERGROUP, files: [{ path: "a.txt" }, { path: "b.txt" }] })).toEqual({
      headline: { text: "About to send files to {chat}", values: { chat: "Old Friends" } },
      facts: [
        { label: "Chat", value: { text: "Supergroup" } },
        { label: "Files", value: { text: "{count} files", values: { count: 2 } } },
        { label: "Size", value: { text: "{bytes} bytes", values: { bytes: 8 } } },
      ],
      pins: { [`sha256:${first}`]: sha256("abc"), [`sha256:${second}`]: sha256("defgh") },
    })
  })

  test("the file is named as it is sent, made safe", async () => {
    t.write(".hidden.txt")
    const description = await describeCall({ files: [{ path: ".hidden.txt" }] })
    expect(description?.headline?.values).toEqual({ file: "_.hidden.txt", chat: "Alice Example" })
  })

  test("Saved Messages has its own headlines and keeps the Chat fact", async () => {
    t.known({ id: OTHER_USER, kind: "self", name: "Alice Example" })
    t.write("a.txt", "x")
    t.write("b.txt", "y")
    const one = await describeCall({ chat: OTHER_USER, files: [{ path: "a.txt" }] })
    expect(one?.headline).toEqual({ text: "About to send {file} to Saved Messages", values: { file: "a.txt" } })
    expect(one?.facts[0]).toEqual({ label: "Chat", value: { text: "Saved Messages" } })
    const many = await describeCall({ chat: OTHER_USER, files: [{ path: "a.txt" }, { path: "b.txt" }] })
    expect(many?.headline).toEqual({ text: "About to send files to Saved Messages" })
  })

  test("a chat without a name gets no headline, and keeps the facts", async () => {
    t.known({ id: OTHER_USER, kind: "user", name: null, username: null })
    t.write("a.txt", "x")
    const description = await describeCall({ chat: OTHER_USER, files: [{ path: "a.txt" }] })
    expect(description?.headline).toBeUndefined()
    expect(description?.facts.map((fact) => fact.label)).toEqual(["Chat", "Size"])
  })

  test("adds the topic's title and the reply after the kind of chat, before the count and the size", async () => {
    t.known({ id: SUPERGROUP, kind: "supergroup", name: "Old Friends", username: null })
    upsertTopics(t.mirror, [{ chat: SUPERGROUP, id: 5, title: "Talk" }], 1)
    t.write("a.txt", "x")
    t.write("b.txt", "y")
    const description = await describeCall({
      chat: SUPERGROUP,
      files: [{ path: "a.txt" }, { path: "b.txt" }],
      topic: 5,
      reply_to: 42,
    })
    expect(description?.facts.map((fact) => fact.label)).toEqual(["Chat", "Topic", "Reply to", "Files", "Size"])
    expect(description?.facts[1]).toEqual({ label: "Topic", value: "Talk" })
    expect(description?.facts[2]).toEqual({ label: "Reply to", value: { text: "message {id}", values: { id: 42 } } })
  })

  test("the caption is shown trimmed, and left out when there is none or it is blank", async () => {
    t.write("a.txt", "x")
    const files = [{ path: "a.txt" }]
    expect((await describeCall({ files, caption: "  look  " }))?.text).toEqual({ label: "Caption", body: "look" })
    expect(await describeCall({ files })).not.toHaveProperty("text")
    expect(await describeCall({ files, caption: "  " })).not.toHaveProperty("text")
  })

  test("keeps the caption whole and every pin, though the prompt cuts them", async () => {
    t.write("a.txt", "x")
    const caption = "c".repeat(CAPTION_MAX_UNITS)
    const whole = await wholeCallDescription(
      telegramFileSend,
      { chat: USER, files: [{ path: "a.txt" }], caption },
      t.context(),
    )
    expect(whole?.text?.body).toBe(caption)
    expect(Object.keys(whole?.pins ?? {})).toHaveLength(1)
  })

  test("gives the same description for the same state", async () => {
    t.write("a.txt", "x")
    const args = { files: [{ path: "a.txt" }], caption: "hi", reply_to: 3 }
    expect(await describeCall(args)).toEqual(await describeCall(args))
  })
})

describe("file send: pinning", () => {
  test("a file rewritten with the same size changes the pins and not the facts", async () => {
    const args = { files: [{ path: "a.txt" }] }
    t.write("a.txt", "before")
    const before = await describeCall(args)
    t.write("a.txt", "after!")
    const after = await describeCall(args)
    expect(after?.facts).toEqual(before?.facts)
    expect(after?.pins).not.toEqual(before?.pins)
  })
})

describe("file send: a call that would be refused has no description", () => {
  test("a sha256 that does not match the file, but in any case when it does", async () => {
    t.write("a.txt", "x")
    expect(await describeCall({ files: [{ path: "a.txt", sha256: "0".repeat(64) }] })).toBeUndefined()
    expect(await describeCall({ files: [{ path: "a.txt", sha256: sha256("x").toUpperCase() }] })).toBeDefined()
  })

  test("files over the size limit", async () => {
    t.write("a.txt", "x".repeat(60))
    t.write("b.txt", "y".repeat(60))
    const small = createFileSend({ maxTotalBytes: 100 })
    expect(await describeCall({ files: [{ path: "a.txt" }] }, small)).toBeDefined()
    expect(await describeCall({ files: [{ path: "a.txt" }, { path: "b.txt" }] }, small)).toBeUndefined()
  })

  test.each([
    ["the same file twice", { files: [{ path: "a.txt" }, { path: "a.txt" }] }],
    ["a chat the mirror lacks", { chat: OTHER_USER, files: [{ path: "a.txt" }] }],
    ["a name instead of a chat id", { chat: "Alice Example", files: [{ path: "a.txt" }] }],
    ["an account that is not logged in", { account: "missing", files: [{ path: "a.txt" }] }],
    ["a caption over the limit", { files: [{ path: "a.txt" }], caption: "x".repeat(CAPTION_MAX_UNITS + 1) }],
    ["a file that does not exist", { files: [{ path: "missing.txt" }] }],
    ["a file outside the allowed directories", { files: [{ path: "/etc/hosts" }] }],
  ])("%s", async (_name, args) => {
    t.write("a.txt", "x")
    expect(await describeCall(args)).toBeUndefined()
  })
})
