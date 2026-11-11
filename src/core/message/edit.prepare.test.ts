import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ServiceCalls } from "../chat/read.testing"
import { recordDeleted } from "../telegram/mirror-rows"
import { NOW, OTHER_USER, SUPERGROUP, USER } from "../telegram/mirror.testing"
import { createActionFixture, OWN_ID, type ActionFixture } from "./action.testing"

let t: ActionFixture
let calls: ServiceCalls

beforeEach(async () => {
  t = createActionFixture()
  calls = await t.serveEdit()
})

afterEach(async () => {
  await t.stopServices()
  t.close()
})

describe("edit: the mirror is checked before any request", () => {
  test("a chat the mirror lacks is not found", async () => {
    t.own()
    const error = await t.editFails({ chat: OTHER_USER })
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("No chat with this id")
    expect(calls).toHaveLength(0)
  })

  test("a message the mirror lacks is not found, saying so", async () => {
    t.own()
    const error = await t.editFails({ id: 99 })
    expect(error).toMatchObject({ code: "not_found", message: "No message 99 in this chat; nothing was edited." })
    expect(calls).toHaveLength(0)
  })

  test("a message of a chat the mirror does not keep cannot be checked", async () => {
    t.known({ id: SUPERGROUP, kind: "supergroup", name: "Old Friends", username: null })
    const error = await t.editFails({ chat: SUPERGROUP })
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("not mirrored")
    expect(calls).toHaveLength(0)
  })

  test("another person's message is forbidden, in the service's words", async () => {
    t.follow()
    t.store({ id: OWN_ID, body: "old text" })
    const error = await t.editFails()
    expect(error).toMatchObject({ code: "forbidden", message: "Only your own messages can be edited." })
    expect(calls).toHaveLength(0)
  })

  test("a message in Saved Messages stored as not sent by the user is left to the service", async () => {
    t.follow({ id: OTHER_USER, kind: "self", name: "Me", username: null })
    t.store({ chat: OTHER_USER, id: OWN_ID, body: "old text" })
    await t.edit({ chat: OTHER_USER })
    expect(calls).toEqual([{ method: "edit", params: { chat: OTHER_USER, id: OWN_ID, text: "new text" } }])
  })

  test("a chat the user has left is forbidden", async () => {
    t.follow({ left: true })
    const error = await t.editFails()
    expect(error).toMatchObject({ code: "forbidden", message: "You are no longer in this chat; nothing was edited." })
    expect(calls).toHaveLength(0)
  })

  test("a message the mirror has as deleted is not found", async () => {
    t.own()
    recordDeleted(t.mirror, USER, 99, NOW)
    const error = await t.editFails({ id: 99 })
    expect(error).toMatchObject({ code: "not_found", message: "This message was deleted; nothing was edited." })
    expect(calls).toHaveLength(0)
  })

  test("the text the message already has is refused, in the service's words", async () => {
    t.own()
    const error = await t.editFails({ text: "  old text " })
    expect(error).toMatchObject({
      code: "invalid_argument",
      message: "The text is the same as the message's; nothing to edit.",
    })
    expect(calls).toHaveLength(0)
  })

  test("a service message and a message with nothing to caption are refused", async () => {
    t.own({ id: 8, kind: "service", body: null, action: { type: "pin" } })
    t.store({ id: 9, fromMe: true, sender: null, body: null, media: null })
    for (const id of [8, 9]) {
      const error = await t.editFails({ id })
      expect(error).toMatchObject({ code: "invalid_argument" })
      expect(error.message).toContain("no text or caption to edit")
    }
    expect(calls).toHaveLength(0)
  })

  test("a link preview is part of the text, not media to caption", async () => {
    t.own({ id: 8, body: null, media: { type: "webpage" } })
    const error = await t.editFails({ id: 8 })
    expect(error.message).toContain("no text or caption to edit")
    expect(calls).toHaveLength(0)
  })

  test("a message with media and no caption can be given one", async () => {
    t.own({ id: 8, body: null, media: { type: "photo" } })
    await t.edit({ id: 8 })
    expect(calls).toEqual([{ method: "edit", params: { chat: USER, id: 8, text: "new text" } }])
  })
})
