import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { callDescription, wholeCallDescription } from "../describe"
import { GROUP, NOW, OTHER_USER, USER } from "../telegram/mirror.testing"
import { DOWNLOAD_CONTEXT } from "../tool.testing"
import { createActionFixture, THEIR_ID, type ActionFixture } from "./action.testing"
import { telegramMessagePin } from "./pin"

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
  callDescription(telegramMessagePin, { chat: USER, id: THEIR_ID, ...args }, context())
const labels = (description: Awaited<ReturnType<typeof describeCall>>) => description?.facts.map(({ label }) => label)
const YES = { text: "Yes" }

describe("pin: the approval description", () => {
  test("names the chat, shows the message and its text now, and has no text of its own", async () => {
    t.theirs({ ts: NOW - 5000 })
    expect(await describeCall({})).toEqual({
      headline: {
        text: "About to pin message {id} in {chat}",
        values: { id: String(THEIR_ID), chat: "Alice Example" },
      },
      facts: [
        { label: "Chat", value: { text: "Person" } },
        { label: "Message", value: { text: "message {id}", values: { id: THEIR_ID } } },
        { label: "Current", value: "from Alice" },
      ],
      pins: { edited: String(NOW - 5000) },
    })
  })

  test("an unpin says so in the headline", async () => {
    t.theirs()
    expect((await describeCall({ unpin: true }))?.headline).toEqual({
      text: "About to unpin message {id} in {chat}",
      values: { id: String(THEIR_ID), chat: "Alice Example" },
    })
  })

  test("says Saved Messages for the user's own chat, for a pin and an unpin", async () => {
    t.follow({ id: OTHER_USER, kind: "self", name: "Me", username: null })
    t.store({ chat: OTHER_USER, id: THEIR_ID, fromMe: true, sender: null, body: "a note" })
    const pin = await describeCall({ chat: OTHER_USER })
    expect(pin?.headline).toEqual({
      text: "About to pin message {id} in Saved Messages",
      values: { id: String(THEIR_ID) },
    })
    expect(pin?.facts[0]).toEqual({ label: "Chat", value: { text: "Saved Messages" } })
    expect((await describeCall({ chat: OTHER_USER, unpin: true }))?.headline).toEqual({
      text: "About to unpin message {id} in Saved Messages",
      values: { id: String(THEIR_ID) },
    })
  })

  test("says Notify when the pin tells the members", async () => {
    t.follow({ id: GROUP, kind: "group", name: "Team Chat", username: null })
    t.store({ chat: GROUP, id: THEIR_ID, body: "hello team" })
    const description = await describeCall({ chat: GROUP, notify: true })
    expect(labels(description)).toEqual(["Chat", "Message", "Current", "Notify"])
    expect(description?.facts[3]).toEqual({ label: "Notify", value: YES })
    expect(labels(await describeCall({ chat: GROUP, notify: false }))).toEqual(["Chat", "Message", "Current"])
  })

  test("says Both sides when the pin is for the other person too, after Notify", async () => {
    t.theirs()
    expect((await describeCall({ both_sides: true }))?.facts.slice(3)).toEqual([{ label: "Both sides", value: YES }])
    expect((await describeCall({ notify: true, both_sides: true }))?.facts.slice(3)).toEqual([
      { label: "Notify", value: YES },
      { label: "Both sides", value: YES },
    ])
  })

  test("pins the time of the last edit, so a message edited after the prompt is stale", async () => {
    t.theirs({ ts: NOW - 5000 })
    const before = await wholeCallDescription(telegramMessagePin, { chat: USER, id: THEIR_ID }, context())
    t.theirs({ ts: NOW - 5000, edited: NOW - 1000, body: "edited" })
    const after = await wholeCallDescription(telegramMessagePin, { chat: USER, id: THEIR_ID }, context())
    expect(before?.pins).toEqual({ edited: String(NOW - 5000) })
    expect(after?.pins).toEqual({ edited: String(NOW - 1000) })
  })

  test("keeps the direction in a headline without the chat's name, and keeps the facts", async () => {
    t.follow({ name: null })
    t.store({ id: THEIR_ID, body: "from Alice" })
    const description = await describeCall({})
    expect(description?.headline).toEqual({ text: "About to pin message {id}", values: { id: String(THEIR_ID) } })
    expect((await describeCall({ unpin: true }))?.headline).toEqual({
      text: "About to unpin message {id}",
      values: { id: String(THEIR_ID) },
    })
    expect(labels(description)).toEqual(["Chat", "Message", "Current"])
  })

  test("gives no description for a call it would refuse", async () => {
    t.theirs()
    t.follow({ id: GROUP, kind: "group", name: "Team Chat", username: null })
    t.store({ chat: GROUP, id: THEIR_ID, body: "hello team" })
    expect(await describeCall({ chat: "-4999" })).toBeUndefined()
    expect(await describeCall({ chat: "Alice Example" })).toBeUndefined()
    expect(await describeCall({ id: 99 })).toBeUndefined()
    expect(await describeCall({ unpin: true, notify: true })).toBeUndefined()
    expect(await describeCall({ unpin: true, both_sides: true })).toBeUndefined()
    expect(await describeCall({ chat: GROUP, both_sides: true })).toBeUndefined()
  })

  test("gives the same description for the same state", async () => {
    t.theirs()
    expect(await describeCall({ notify: true })).toEqual(await describeCall({ notify: true }))
  })
})
