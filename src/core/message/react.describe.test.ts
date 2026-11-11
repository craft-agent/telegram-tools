import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { callDescription, MAX_VALUE_LENGTH, wholeCallDescription } from "../describe"
import { NOW, OTHER_USER, USER } from "../telegram/mirror.testing"
import { DOWNLOAD_CONTEXT } from "../tool.testing"
import { createActionFixture, THEIR_ID, THUMBS_UP, type ActionFixture } from "./action.testing"
import { telegramMessageReact } from "./react"

let t: ActionFixture

beforeEach(() => {
  t = createActionFixture()
})

afterEach(async () => {
  await t.stopServices()
  t.close()
})

const HEART = "❤️"
const context = () => ({ cwd: t.stateDir, stateDir: t.stateDir, ...DOWNLOAD_CONTEXT })
const describeCall = (args: object) =>
  callDescription(telegramMessageReact, { chat: USER, id: THEIR_ID, emoji: THUMBS_UP, ...args }, context())
const whole = (args: object) =>
  wholeCallDescription(telegramMessageReact, { chat: USER, id: THEIR_ID, emoji: THUMBS_UP, ...args }, context())
const labels = (description: Awaited<ReturnType<typeof describeCall>>) => description?.facts.map(({ label }) => label)

describe("react: the approval description", () => {
  test("names the chat and the emoji, shows the message and its text now, and has no text of its own", async () => {
    t.theirs({ ts: NOW - 5000 })
    expect(await describeCall({})).toEqual({
      headline: {
        text: "About to react {emoji} to message {id} in {chat}",
        values: { id: String(THEIR_ID), chat: "Alice Example", emoji: THUMBS_UP },
      },
      facts: [
        { label: "Chat", value: { text: "Person" } },
        { label: "Message", value: { text: "message {id}", values: { id: THEIR_ID } } },
        { label: "Current", value: "from Alice" },
      ],
      pins: { edited: String(NOW - 5000), reaction: "" },
    })
  })

  test("a removal says whose reaction goes, and quotes no emoji", async () => {
    t.theirs({ reactions: [{ emoji: THUMBS_UP, count: 2, mine: true }] })
    const description = await describeCall({ emoji: undefined, remove: true })
    expect(description?.headline).toEqual({
      text: "About to remove your reaction from message {id} in {chat}",
      values: { id: String(THEIR_ID), chat: "Alice Example" },
    })
    expect(description?.facts[3]).toEqual({ label: "Replaces", value: THUMBS_UP })
  })

  test("says Saved Messages for the user's own chat", async () => {
    t.follow({ id: OTHER_USER, kind: "self", name: "Me", username: null })
    t.store({ chat: OTHER_USER, id: THEIR_ID, fromMe: true, sender: null, body: "a note" })
    const set = await describeCall({ chat: OTHER_USER })
    expect(set?.headline).toEqual({
      text: "About to react {emoji} to message {id} in Saved Messages",
      values: { id: String(THEIR_ID), emoji: THUMBS_UP },
    })
    expect(set?.facts[0]).toEqual({ label: "Chat", value: { text: "Saved Messages" } })
    const removal = await describeCall({ chat: OTHER_USER, emoji: undefined, remove: true })
    expect(removal?.headline).toEqual({
      text: "About to remove your reaction from message {id} in Saved Messages",
      values: { id: String(THEIR_ID) },
    })
  })

  test("shows the reaction it replaces, from the mirror, when setting a different one", async () => {
    t.theirs({
      reactions: [
        { emoji: THUMBS_UP, count: 3 },
        { emoji: HEART, count: 1, mine: true },
      ],
    })
    const description = await describeCall({})
    expect(labels(description)).toEqual(["Chat", "Message", "Current", "Replaces"])
    expect(description?.facts[3]).toEqual({ label: "Replaces", value: HEART })
  })

  test("shows no replaced reaction for the same emoji, for none of the user's own, or for others' reactions", async () => {
    t.theirs({ reactions: [{ emoji: THUMBS_UP, count: 1, mine: true }] })
    expect(labels(await describeCall({}))).toEqual(["Chat", "Message", "Current"])
    t.theirs({ reactions: [{ emoji: HEART, count: 4 }] })
    expect(labels(await describeCall({}))).toEqual(["Chat", "Message", "Current"])
    expect(labels(await describeCall({ emoji: undefined, remove: true }))).toEqual(["Chat", "Message", "Current"])
  })

  test("pins the time of the last edit and the user's reaction, so a change after the prompt is stale", async () => {
    t.theirs({ ts: NOW - 5000, reactions: [{ emoji: HEART, count: 1, mine: true }] })
    const before = await whole({})
    t.theirs({ ts: NOW - 5000, edited: NOW - 1000, reactions: [{ emoji: HEART, count: 1, mine: true }] })
    const edited = await whole({})
    t.theirs({ ts: NOW - 5000, reactions: [{ emoji: THUMBS_UP, count: 1, mine: true }] })
    const reacted = await whole({})
    expect(before?.pins).toEqual({ edited: String(NOW - 5000), reaction: HEART })
    expect(edited?.pins).toEqual({ edited: String(NOW - 1000), reaction: HEART })
    expect(reacted?.pins).toEqual({ edited: String(NOW - 1000), reaction: THUMBS_UP })
  })

  test("cuts a long current text to the budget of a fact's value", async () => {
    t.theirs({ body: "a".repeat(MAX_VALUE_LENGTH * 2) })
    const current = (await whole({}))?.facts[2]?.value as string
    expect(Array.from(current)).toHaveLength(MAX_VALUE_LENGTH)
    expect(current.endsWith("…")).toBe(true)
  })

  test("shows the kind of the media of a message with no caption", async () => {
    t.theirs({ body: null, media: { type: "voice" } })
    expect((await describeCall({}))?.facts[2]).toEqual({ label: "Media", value: { text: "Voice message" } })
  })

  test("keeps the direction and emoji in a headline without the chat's name, and keeps the facts", async () => {
    t.follow({ name: null })
    t.store({ id: THEIR_ID, body: "from Alice" })
    const description = await describeCall({})
    expect(description?.headline).toEqual({
      text: "About to react {emoji} to message {id}",
      values: { id: String(THEIR_ID), emoji: THUMBS_UP },
    })
    expect((await describeCall({ emoji: undefined, remove: true }))?.headline).toEqual({
      text: "About to remove your reaction from message {id}",
      values: { id: String(THEIR_ID) },
    })
    expect(labels(description)).toEqual(["Chat", "Message", "Current"])
  })

  test("gives no description for a call it would refuse", async () => {
    t.theirs()
    expect(await describeCall({ chat: OTHER_USER })).toBeUndefined()
    expect(await describeCall({ chat: "Alice Example" })).toBeUndefined()
    expect(await describeCall({ id: 99 })).toBeUndefined()
    expect(await describeCall({ emoji: "ok" })).toBeUndefined()
    expect(await describeCall({ emoji: undefined })).toBeUndefined()
    expect(await describeCall({ remove: true })).toBeUndefined()
  })

  test("gives the same description for the same state", async () => {
    t.theirs({ reactions: [{ emoji: HEART, count: 1, mine: true }] })
    expect(await describeCall({})).toEqual(await describeCall({}))
  })
})
