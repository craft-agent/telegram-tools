import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ServiceCalls } from "../chat/read.testing"
import { recordDeleted } from "../telegram/mirror-rows"
import { NOW, OTHER_USER, SUPERGROUP, USER } from "../telegram/mirror.testing"
import { createActionFixture, THEIR_ID, THUMBS_UP, type ActionFixture } from "./action.testing"

let t: ActionFixture
let calls: ServiceCalls

beforeEach(async () => {
  t = createActionFixture()
  calls = await t.serveReact()
})

afterEach(async () => {
  await t.stopServices()
  t.close()
})

describe("react: the mirror is checked before any request", () => {
  test("a chat the mirror lacks is not found", async () => {
    t.theirs()
    const error = await t.reactFails({ chat: OTHER_USER })
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("No chat with this id")
    expect(calls).toHaveLength(0)
  })

  test("a message the mirror lacks is not found, saying so", async () => {
    t.theirs()
    expect(await t.reactFails({ id: 99 })).toMatchObject({
      code: "not_found",
      message: "No message 99 in this chat; nothing was changed.",
    })
    expect(calls).toHaveLength(0)
  })

  test("a message of a chat the mirror does not keep cannot be checked", async () => {
    t.known({ id: SUPERGROUP, kind: "supergroup", name: "Old Friends", username: null })
    const error = await t.reactFails({ chat: SUPERGROUP })
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("not mirrored")
    expect(calls).toHaveLength(0)
  })

  test("a chat the user has left is forbidden", async () => {
    t.follow({ left: true })
    expect(await t.reactFails()).toMatchObject({
      code: "forbidden",
      message: "You are no longer in this chat; nothing was changed.",
    })
    expect(calls).toHaveLength(0)
  })

  test("a message the mirror has as deleted is not found", async () => {
    t.theirs()
    recordDeleted(t.mirror, USER, 99, NOW)
    expect(await t.reactFails({ id: 99 })).toMatchObject({
      code: "not_found",
      message: "This message was deleted; nothing was changed.",
    })
    expect(calls).toHaveLength(0)
  })
})

describe("react: any message still in the chat can be reacted to", () => {
  test("another person's message", async () => {
    t.theirs()
    await t.react()
    expect(calls).toHaveLength(1)
  })

  test("the user's own message", async () => {
    t.own()
    await t.react({ id: 7 })
    expect(calls).toEqual([{ method: "react", params: { chat: USER, id: 7, emoji: THUMBS_UP } }])
  })

  test("a service message", async () => {
    t.theirs({ id: 9, kind: "service", body: null, action: { type: "pin" } })
    await t.react({ id: 9 })
    expect(calls).toHaveLength(1)
  })

  test("an emoji the mirror shows as the user's own is left to the service, which answers `already`", async () => {
    t.theirs({ reactions: [{ emoji: THUMBS_UP, count: 1, mine: true }] })
    await t.react()
    expect(calls).toEqual([{ method: "react", params: { chat: USER, id: THEIR_ID, emoji: THUMBS_UP } }])
  })
})
