import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { callDescription, wholeCallDescription } from "../describe"
import { recordDeleted } from "../telegram/mirror-rows"
import { NOW, OTHER_USER, USER } from "../telegram/mirror.testing"
import { DOWNLOAD_CONTEXT } from "../tool.testing"
import { createActionFixture, OWN_ID, type ActionFixture } from "./action.testing"
import { telegramMessageDelete } from "./delete"

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
  callDescription(telegramMessageDelete, { chat: USER, id: OWN_ID, ...args }, context())

describe("delete: the approval description", () => {
  test("names the chat by the mirror's name, shows the message and its text now, and has no text of its own", async () => {
    t.own({ ts: NOW - 5000 })
    expect(await describeCall({})).toEqual({
      headline: {
        text: "About to delete message {id} from {chat} for everyone",
        values: { id: String(OWN_ID), chat: "Alice Example" },
      },
      facts: [
        { label: "Chat", value: { text: "Person" } },
        { label: "Message", value: { text: "message {id}", values: { id: OWN_ID } } },
        { label: "Current", value: "old text" },
      ],
      pins: { edited: String(NOW - 5000) },
    })
  })

  test("pins the time of the last edit, so a message edited after the prompt is stale", async () => {
    t.own({ ts: NOW - 5000, edited: NOW - 1000 })
    const description = await wholeCallDescription(telegramMessageDelete, { chat: USER, id: OWN_ID }, context())
    expect(description?.pins).toEqual({ edited: String(NOW - 1000) })
  })

  test("says Saved Messages for the user's own chat", async () => {
    t.follow({ id: OTHER_USER, kind: "self", name: "Me", username: null })
    t.store({ chat: OTHER_USER, id: OWN_ID, fromMe: true, sender: null, body: "old text" })
    const description = await describeCall({ chat: OTHER_USER })
    expect(description?.headline).toEqual({
      text: "About to delete message {id} from Saved Messages",
      values: { id: String(OWN_ID) },
    })
    expect(description?.facts[0]).toEqual({ label: "Chat", value: { text: "Saved Messages" } })
  })

  test("shows the kind of the media of a message with no caption", async () => {
    t.own({ body: null, media: { type: "voice" } })
    expect((await describeCall({}))?.facts[2]).toEqual({ label: "Media", value: { text: "Voice message" } })
  })

  test("shows no current text for a message with neither text nor media", async () => {
    t.own({ kind: "service", body: null, action: { type: "pin" } })
    expect((await describeCall({}))?.facts.map(({ label }) => label)).toEqual(["Chat", "Message"])
  })

  test("a message the mirror has as deleted has nothing to show or to pin", async () => {
    t.own()
    recordDeleted(t.mirror, USER, 99, NOW)
    const description = await describeCall({ id: 99 })
    expect(description?.facts.map(({ label }) => label)).toEqual(["Chat", "Message"])
    expect(description).not.toHaveProperty("pins")
  })

  test("keeps a headline without the chat's name, and keeps the facts", async () => {
    t.follow({ name: null })
    t.store({ id: OWN_ID, fromMe: true, sender: null, body: "old text" })
    const description = await describeCall({})
    expect(description?.headline).toEqual({
      text: "About to delete message {id} for everyone",
      values: { id: String(OWN_ID) },
    })
    expect(description?.facts).toHaveLength(3)
  })

  test("gives no description for a call it would refuse", async () => {
    t.own()
    expect(await describeCall({ chat: OTHER_USER })).toBeUndefined()
    expect(await describeCall({ chat: "Alice Example" })).toBeUndefined()
    expect(await describeCall({ id: 99 })).toBeUndefined()
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
