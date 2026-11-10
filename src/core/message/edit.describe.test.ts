import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { callDescription, MAX_VALUE_LENGTH, wholeCallDescription } from "../describe"
import { NOW, OTHER_USER, USER } from "../telegram/mirror.testing"
import { DOWNLOAD_CONTEXT } from "../tool.testing"
import { createActionFixture, OWN_ID, type ActionFixture } from "./action.testing"
import { telegramMessageEdit } from "./edit"

let t: ActionFixture

beforeEach(() => {
  t = createActionFixture()
})

afterEach(async () => {
  await t.stopServices()
  t.close()
})

const context = () => ({ cwd: t.stateDir, stateDir: t.stateDir, ...DOWNLOAD_CONTEXT })
const describeCall = (args: object) =>
  callDescription(telegramMessageEdit, { chat: USER, id: OWN_ID, text: "new text", ...args }, context())

describe("edit: the approval description", () => {
  test("names the chat by the mirror's name, shows the message and its text now, and carries the new text", async () => {
    t.own({ ts: NOW - 5000 })
    expect(await describeCall({ text: "  new text  " })).toEqual({
      headline: {
        text: "About to edit message {id} in {chat}",
        values: { id: String(OWN_ID), chat: "Alice Example" },
      },
      facts: [
        { label: "Chat", value: { text: "Person" } },
        { label: "Message", value: { text: "message {id}", values: { id: OWN_ID } } },
        { label: "Current", value: "old text" },
      ],
      text: { label: "New text", body: "new text" },
      pins: { edited: String(NOW - 5000) },
    })
  })

  test("pins the time of the last edit, so a message edited after the prompt is stale", async () => {
    t.own({ ts: NOW - 5000 })
    const before = await wholeCallDescription(telegramMessageEdit, { chat: USER, id: OWN_ID, text: "x" }, context())
    t.store({ id: OWN_ID, fromMe: true, sender: null, body: "edited text", edited: NOW - 1000 })
    const after = await wholeCallDescription(telegramMessageEdit, { chat: USER, id: OWN_ID, text: "x" }, context())
    expect(before?.pins).toEqual({ edited: String(NOW - 5000) })
    expect(after?.pins).toEqual({ edited: String(NOW - 1000) })
    expect(after?.facts[2]).toEqual({ label: "Current", value: "edited text" })
  })

  test("says Saved Messages for the user's own chat", async () => {
    t.follow({ id: OTHER_USER, kind: "self", name: "Me", username: null })
    t.store({ chat: OTHER_USER, id: OWN_ID, fromMe: true, sender: null, body: "old text" })
    const description = await describeCall({ chat: OTHER_USER })
    expect(description?.headline).toEqual({
      text: "About to edit message {id} in Saved Messages",
      values: { id: String(OWN_ID) },
    })
    expect(description?.facts[0]).toEqual({ label: "Chat", value: { text: "Saved Messages" } })
  })

  test("cuts a long current text to the budget of a fact's value", async () => {
    t.own({ body: "a".repeat(MAX_VALUE_LENGTH * 2) })
    const description = await wholeCallDescription(
      telegramMessageEdit,
      { chat: USER, id: OWN_ID, text: "x" },
      context(),
    )
    const current = description?.facts[2]?.value as string
    expect(Array.from(current)).toHaveLength(MAX_VALUE_LENGTH)
    expect(current.endsWith("…")).toBe(true)
  })

  test("shows the caption of a message with media, else the kind of its media", async () => {
    t.own({ id: 8, body: "a caption", media: { type: "photo" } })
    t.own({ id: 9, body: null, media: { type: "video" } })
    expect((await describeCall({ id: 8 }))?.facts[2]).toEqual({ label: "Current", value: "a caption" })
    expect((await describeCall({ id: 9 }))?.facts[2]).toEqual({ label: "Current", value: "video" })
  })

  test("gives no headline for a chat without a name, and keeps the facts", async () => {
    t.follow({ name: null })
    t.store({ id: OWN_ID, fromMe: true, sender: null, body: "old text" })
    const description = await describeCall({})
    expect(description?.headline).toBeUndefined()
    expect(description?.facts.map(({ label }) => label)).toEqual(["Chat", "Message", "Current"])
  })

  test("gives no description for a call it would refuse", async () => {
    t.own()
    expect(await describeCall({ chat: OTHER_USER })).toBeUndefined()
    expect(await describeCall({ chat: "Alice Example" })).toBeUndefined()
    expect(await describeCall({ id: 99 })).toBeUndefined()
    expect(await describeCall({ text: "old text" })).toBeUndefined()
    expect(await describeCall({ text: "   " })).toBeUndefined()
  })

  test("gives no description for another person's message", async () => {
    t.follow()
    t.store({ id: OWN_ID, body: "old text" })
    expect(await describeCall({})).toBeUndefined()
  })

  test("gives the same description for the same state", async () => {
    t.own()
    expect(await describeCall({})).toEqual(await describeCall({}))
  })
})
