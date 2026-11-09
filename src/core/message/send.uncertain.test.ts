import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { outgoing } from "../chat/read.testing"
import { ToolError } from "../errors"
import { deleteMessages } from "../telegram/ingest-delete"
import { labelPaths } from "../telegram/labels"
import { inTransaction } from "../telegram/mirror"
import type { MessageInput } from "../telegram/mirror-input"
import { NOW, OTHER_USER, USER, deleteInput } from "../telegram/mirror.testing"
import { formatLocalTime } from "../time"
import { MAX_SENT_LIKE, SENT_LOOKBACK_MS } from "./constants"
import { createSendFixture, type SendFixture } from "./send.testing"
import { withSentLike } from "./uncertain"

let t: SendFixture

beforeEach(async () => {
  t = createSendFixture()
  t.follow({ id: USER })
  await t.serveLost()
})

afterEach(async () => {
  await t.stopServices()
  t.close()
})

const ago = (ms: number) => Date.now() - ms
const mine = (id: number, agoMs: number, overrides: Partial<MessageInput> = {}) =>
  outgoing({ id, ts: ago(agoMs), body: "hello", ...overrides })
const found = (error: ToolError) => (error.details as { sent_like_this: { id: number; time: string }[] }).sent_like_this

describe("send: an uncertain send carries what the mirror shows", () => {
  test("lists the user's own messages with this text since the send began, newest first, by id and time", async () => {
    t.store(mine(1, 10_000), mine(2, 30_000), mine(3, 20_000))
    const error = await t.sendFails()
    expect(error.code).toBe("uncertain")
    expect(found(error).map(({ id }) => id)).toEqual([1, 3, 2])
    expect(found(error)[0]!.time).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+[+-]\d{2}:\d{2}$/)
    expect(Object.keys(error.details ?? {})).toEqual(["sent_like_this"])
    expect(error.message).toContain("send may have taken effect")
    expect(error.message).toContain(
      "The mirror shows 3 messages of yours with this text since the send began; check them in Telegram.",
    )
  })

  test("says so in the singular for one", async () => {
    t.store(mine(1, 10_000))
    const error = await t.sendFails()
    expect(found(error)).toHaveLength(1)
    expect(error.message).toContain(
      "The mirror shows 1 message of yours with this text since the send began; check it in Telegram.",
    )
  })

  test("counts only the same text, from the user, not deleted, in this chat and within the window", async () => {
    t.follow({ id: OTHER_USER })
    t.store(
      mine(1, 10_000),
      mine(2, 10_000, { body: "hello there" }),
      mine(3, 10_000, { body: "Hello" }),
      mine(4, 10_000, { fromMe: false, sender: USER }),
      mine(5, 10_000, { chat: OTHER_USER }),
      mine(6, SENT_LOOKBACK_MS + 60_000),
      mine(7, 20_000),
    )
    inTransaction(t.mirror, () =>
      deleteMessages(t.mirror, { now: NOW, keepDisappearing: false }, deleteInput({ ids: [7] })),
    )
    const error = await t.sendFails()
    expect(found(error).map(({ id }) => id)).toEqual([1])
  })

  test("lists at most as many as it can show", async () => {
    t.store(...Array.from({ length: MAX_SENT_LIKE + 2 }, (_, index) => mine(index + 1, 10_000 + index * 1_000)))
    const error = await t.sendFails()
    expect(found(error).map(({ id }) => id)).toEqual([1, 2, 3, 4, 5])
    expect(error.message).toContain(`The mirror shows ${MAX_SENT_LIKE} messages of yours`)
  })

  test("with none, says it may still arrive and lists nothing", async () => {
    t.store(mine(1, 10_000, { body: "something else" }))
    const error = await t.sendFails()
    expect(error.code).toBe("uncertain")
    expect(found(error)).toEqual([])
    expect(error.message).toContain("send may have taken effect")
    expect(error.message).toContain("The mirror shows none of yours with this text yet; it may still arrive.")
  })

  test("searches for the trimmed text, which is what was sent", async () => {
    t.store(mine(1, 10_000, { body: "hello there" }))
    const error = await t.sendFails({ text: "  hello there\n" })
    expect(found(error).map(({ id }) => id)).toEqual([1])
  })

  test("never says it was or was not sent", async () => {
    t.store(mine(1, 10_000))
    expect((await t.sendFails()).message).not.toMatch(/was sent|was not sent|not delivered|was delivered/i)
  })

  test("an unreadable mirror leaves the original error as it was", async () => {
    t.closeMirror()
    const { mirror } = labelPaths(t.stateDir, "default")
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${mirror}${suffix}`, { force: true })
    const error = await t.sendFails()
    expect(error.code).toBe("uncertain")
    expect(error.message).toContain("send may have taken effect")
    expect(error.message).not.toContain("The mirror shows")
    expect(error.details).toBeUndefined()
  })
})

describe("withSentLike", () => {
  const paths = () => labelPaths(t.stateDir, "default")
  const original = new ToolError("uncertain", "It may have gone out.", { cause: new Error("lost"), details: { a: 1 } })

  test("keeps the code, the cause and the details the error had", () => {
    const error = withSentLike(original, paths(), USER, "hello", Date.now())
    expect(error).toMatchObject({ code: "uncertain", cause: original.cause, details: { a: 1, sent_like_this: [] } })
    expect(error.message).toBe(
      "It may have gone out. The mirror shows none of yours with this text yet; it may still arrive.",
    )
  })

  test("leaves out a cause the error did not have", () => {
    const error = withSentLike(new ToolError("uncertain", "Maybe."), paths(), USER, "hello", Date.now())
    expect("cause" in error).toBe(false)
  })

  test("the window opens a minute before the send began, inclusive", () => {
    const startedAt = NOW
    t.store(
      outgoing({ id: 1, ts: startedAt - SENT_LOOKBACK_MS, body: "hello" }),
      outgoing({ id: 2, ts: startedAt - SENT_LOOKBACK_MS - 1, body: "hello" }),
      outgoing({ id: 3, ts: startedAt + 5_000, body: "hello" }),
    )
    const error = withSentLike(original, paths(), USER, "hello", startedAt)
    expect(found(error)).toEqual([
      { id: 3, time: formatLocalTime(startedAt + 5_000) },
      { id: 1, time: formatLocalTime(startedAt - SENT_LOOKBACK_MS) },
    ])
  })
})
