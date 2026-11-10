import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ServiceCalls } from "../chat/read.testing"
import { recordDeleted } from "../telegram/mirror-rows"
import { NOW, OTHER_USER, SUPERGROUP, USER } from "../telegram/mirror.testing"
import { createActionFixture, type ActionFixture } from "./action.testing"

let t: ActionFixture
let calls: ServiceCalls

beforeEach(async () => {
  t = createActionFixture()
  calls = await t.servePin()
})

afterEach(async () => {
  await t.stopServices()
  t.close()
})

describe("pin: the mirror is checked before any request", () => {
  test("a chat the mirror lacks is not found", async () => {
    t.theirs()
    const error = await t.pinFails({ chat: OTHER_USER })
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("No chat with this id")
    expect(calls).toHaveLength(0)
  })

  test("a message the mirror lacks is not found, in the words of a pin or an unpin", async () => {
    t.theirs()
    expect(await t.pinFails({ id: 99 })).toMatchObject({
      code: "not_found",
      message: "No message 99 in this chat; nothing was pinned.",
    })
    expect(await t.pinFails({ id: 99, unpin: true })).toMatchObject({
      code: "not_found",
      message: "No message 99 in this chat; nothing was unpinned.",
    })
    expect(calls).toHaveLength(0)
  })

  test("a message of a chat the mirror does not keep cannot be checked", async () => {
    t.known({ id: SUPERGROUP, kind: "supergroup", name: "Old Friends", username: null })
    const error = await t.pinFails({ chat: SUPERGROUP })
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("not mirrored")
    expect(calls).toHaveLength(0)
  })

  test("a chat the user has left is forbidden", async () => {
    t.follow({ left: true })
    expect(await t.pinFails()).toMatchObject({
      code: "forbidden",
      message: "You are no longer in this chat; nothing was pinned.",
    })
    expect(await t.pinFails({ unpin: true })).toMatchObject({
      message: "You are no longer in this chat; nothing was unpinned.",
    })
    expect(calls).toHaveLength(0)
  })

  test("a message the mirror has as deleted is not found", async () => {
    t.theirs()
    recordDeleted(t.mirror, USER, 99, NOW)
    expect(await t.pinFails({ id: 99 })).toMatchObject({
      code: "not_found",
      message: "This message was deleted; nothing was pinned.",
    })
    expect(calls).toHaveLength(0)
  })
})

describe("pin: any message still in the chat can be pinned or unpinned", () => {
  test("another person's message, and the user's own", async () => {
    t.theirs()
    t.store({ id: 7, fromMe: true, sender: null, body: "old text" })
    await t.pin()
    await t.pin({ id: 7, unpin: true })
    expect(calls.map(({ params }) => params)).toEqual([
      { chat: USER, id: 8 },
      { chat: USER, id: 7, unpin: true },
    ])
  })

  test("a service message", async () => {
    t.theirs({ id: 9, kind: "service", body: null, action: { type: "pin" } })
    await t.pin({ id: 9 })
    expect(calls).toHaveLength(1)
  })
})
