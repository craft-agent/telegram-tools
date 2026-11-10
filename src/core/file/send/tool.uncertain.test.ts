import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { outgoing } from "../../chat/read.testing"
import { ToolError } from "../../errors"
import { MAX_SENT_LIKE, SENT_LOOKBACK_MS } from "../../message/constants"
import { labelPaths } from "../../telegram/labels"
import type { MediaInfo, MessageInput } from "../../telegram/mirror-input"
import { NOW, OTHER_USER, USER } from "../../telegram/mirror.testing"
import { formatLocalTime } from "../../time"
import { createFileSendFixture, type FileSendFixture } from "./tool.testing"
import { withSentFilesLike } from "./uncertain"

let t: FileSendFixture

beforeEach(async () => {
  t = createFileSendFixture()
  t.follow({ id: USER })
  await t.serveLost()
})

afterEach(async () => {
  await t.close()
})

const ago = (ms: number) => Date.now() - ms
const document = (name: string, size: number): MediaInfo => ({ type: "document", name, size })
const mine = (id: number, agoMs: number, overrides: Partial<MessageInput> = {}) =>
  outgoing({ id, ts: ago(agoMs), media: document("a.txt", 6), ...overrides })
const found = (error: ToolError) =>
  (error.details as { sent_like_this: { id: number; time: string; name: string }[] }).sent_like_this
const send = (caption?: string) =>
  t.filesFailure({
    files: [{ path: t.write("a.txt", "hello\n") }, { path: t.write("b.txt", "xy") }],
    ...(caption && { caption }),
  })

describe("file send: an uncertain send carries what the mirror shows", () => {
  test("lists the user's own messages with a file of the same name and size since the send began, newest first", async () => {
    t.store(mine(1, 10_000), mine(2, 30_000), mine(3, 20_000, { media: document("b.txt", 2) }))
    const error = await send()
    expect(error.code).toBe("uncertain")
    expect(found(error).map(({ id, name }) => [id, name])).toEqual([
      [1, "a.txt"],
      [3, "b.txt"],
      [2, "a.txt"],
    ])
    expect(found(error)[0]!.time).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+[+-]\d{2}:\d{2}$/)
    expect(Object.keys(error.details ?? {})).toEqual(["sent_like_this"])
    expect(error.message).toContain("send_files may have taken effect")
    expect(error.message).toContain(
      "The mirror shows 3 messages of yours with a file of the same name and size since the send began; check them in Telegram.",
    )
    expect(t.outboxEntries()).toEqual([])
  })

  test("says so in the singular for one", async () => {
    t.store(mine(1, 10_000))
    const error = await send()
    expect(found(error)).toHaveLength(1)
    expect(error.message).toContain(
      "The mirror shows 1 message of yours with a file of the same name and size since the send began; check it in Telegram.",
    )
  })

  test("counts only the same name and size, from the user, in this chat and within the window", async () => {
    t.follow({ id: OTHER_USER })
    t.store(
      mine(1, 10_000),
      mine(2, 10_000, { media: document("a.txt", 7) }),
      mine(3, 10_000, { media: document("A.txt", 6) }),
      mine(4, 10_000, { media: null, body: "a.txt" }),
      mine(5, 10_000, { fromMe: false, sender: USER }),
      mine(6, 10_000, { chat: OTHER_USER }),
      mine(7, SENT_LOOKBACK_MS + 60_000),
    )
    expect(found(await send()).map(({ id }) => id)).toEqual([1])
  })

  test("lists at most as many as it can show", async () => {
    t.store(...Array.from({ length: MAX_SENT_LIKE + 2 }, (_, index) => mine(index + 1, 10_000 + index * 1_000)))
    const error = await send()
    expect(found(error).map(({ id }) => id)).toEqual([1, 2, 3, 4, 5])
    expect(error.message).toContain(`The mirror shows ${MAX_SENT_LIKE} messages of yours`)
  })

  test("with none, says they may still arrive and lists nothing", async () => {
    t.store(mine(1, 10_000, { media: document("other.txt", 6) }))
    const error = await send()
    expect(error.code).toBe("uncertain")
    expect(found(error)).toEqual([])
    expect(error.message).toContain(
      "The mirror shows none of yours with a file of the same name and size yet; they may still arrive.",
    )
  })

  test("never says it was or was not sent", async () => {
    t.store(mine(1, 10_000))
    expect((await send()).message).not.toMatch(/was sent|was not sent|not delivered|was delivered/i)
  })

  test("an unreadable mirror leaves the original error as it was", async () => {
    t.closeMirror()
    const { mirror } = labelPaths(t.stateDir, "default")
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${mirror}${suffix}`, { force: true })
    const error = await send()
    expect(error.code).toBe("uncertain")
    expect(error.message).toContain("send_files may have taken effect")
    expect(error.message).not.toContain("The mirror shows")
    expect(error.details).toBeUndefined()
  })
})

describe("withSentFilesLike", () => {
  const paths = () => labelPaths(t.stateDir, "default")
  const original = new ToolError("uncertain", "It may have gone out.", { cause: new Error("lost"), details: { a: 1 } })
  const files = [{ name: "a.txt", size: 6 }]

  test("keeps the code, the cause and the details the error had", () => {
    const error = withSentFilesLike(original, paths(), USER, files, Date.now())
    expect(error).toMatchObject({ code: "uncertain", cause: original.cause, details: { a: 1, sent_like_this: [] } })
  })

  test("the window opens a minute before the send began, inclusive", () => {
    t.store(
      outgoing({ id: 1, ts: NOW - SENT_LOOKBACK_MS, media: document("a.txt", 6) }),
      outgoing({ id: 2, ts: NOW - SENT_LOOKBACK_MS - 1, media: document("a.txt", 6) }),
      outgoing({ id: 3, ts: NOW + 5_000, media: document("a.txt", 6) }),
    )
    const error = withSentFilesLike(original, paths(), USER, files, NOW)
    expect(found(error)).toEqual([
      { id: 3, time: formatLocalTime(NOW + 5_000), name: "a.txt" },
      { id: 1, time: formatLocalTime(NOW - SENT_LOOKBACK_MS), name: "a.txt" },
    ])
  })
})
