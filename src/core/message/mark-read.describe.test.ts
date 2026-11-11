import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { callDescription, wholeCallDescription } from "../describe"
import { upsertTopics } from "../telegram/ingest-chats"
import { NOW, OTHER_USER, SUPERGROUP, USER } from "../telegram/mirror.testing"
import { DOWNLOAD_CONTEXT } from "../tool.testing"
import { createActionFixture, THEIR_ID, type ActionFixture } from "./action.testing"
import { telegramChatMarkRead } from "./mark-read"

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
  callDescription(telegramChatMarkRead, { chat: USER, up_to: THEIR_ID, ...args }, context())

describe("mark read: the approval description", () => {
  test("states the intent", () => {
    expect(telegramChatMarkRead.intent).toBe("About to mark messages read")
  })

  test("names the chat and the message it reaches, and shows no count and no text of its own", async () => {
    t.theirs()
    expect(await describeCall({})).toEqual({
      headline: {
        text: "About to mark {chat} read up to message {id}",
        values: { id: String(THEIR_ID), chat: "Alice Example" },
      },
      facts: [
        { label: "Chat", value: { text: "Person" } },
        { label: "Up to", value: { text: "message {id}", values: { id: THEIR_ID } } },
      ],
    })
  })

  test("says Saved Messages for the user's own chat", async () => {
    t.follow({ id: OTHER_USER, kind: "self", name: "Me", username: null })
    t.store({ chat: OTHER_USER, id: THEIR_ID, fromMe: true, sender: null, body: "a note" })
    const description = await describeCall({ chat: OTHER_USER })
    expect(description?.headline).toEqual({
      text: "About to mark Saved Messages read up to message {id}",
      values: { id: String(THEIR_ID) },
    })
    expect(description?.facts[0]).toEqual({ label: "Chat", value: { text: "Saved Messages" } })
  })

  test("adds the topic's title between the kind of chat and the message", async () => {
    t.follow({ id: SUPERGROUP, kind: "supergroup", name: "Old Friends", username: null, forum: true })
    upsertTopics(t.mirror, [{ chat: SUPERGROUP, id: 5, title: "Talk" }], NOW)
    t.store({ chat: SUPERGROUP, id: 21, topic: 5 })
    expect((await describeCall({ chat: SUPERGROUP, up_to: 21, topic: 5 }))?.facts).toEqual([
      { label: "Chat", value: { text: "Supergroup" } },
      { label: "Topic", value: "Talk" },
      { label: "Up to", value: { text: "message {id}", values: { id: 21 } } },
    ])
  })

  test("shows the id of a topic the mirror has no title for", async () => {
    t.follow({ id: SUPERGROUP, kind: "supergroup", name: "Old Friends", username: null, forum: true })
    t.store({ chat: SUPERGROUP, id: 21, topic: 9 })
    expect((await describeCall({ chat: SUPERGROUP, up_to: 21, topic: 9 }))?.facts[1]).toEqual({
      label: "Topic",
      value: "9",
    })
  })

  test("keeps a headline without the chat's name, and keeps the facts", async () => {
    t.follow({ name: null })
    t.store({ id: THEIR_ID })
    const description = await describeCall({})
    expect(description?.headline).toEqual({
      text: "About to mark messages read up to message {id}",
      values: { id: String(THEIR_ID) },
    })
    expect(description?.facts.map(({ label }) => label)).toEqual(["Chat", "Up to"])
  })

  test("pins nothing: the call changes no message, and the mark never goes back", async () => {
    t.theirs()
    const description = await wholeCallDescription(telegramChatMarkRead, { chat: USER, up_to: THEIR_ID }, context())
    expect(description?.pins).toBeUndefined()
  })

  test("gives no description for a call it would refuse", async () => {
    t.theirs()
    expect(await describeCall({ chat: "-4999" })).toBeUndefined()
    expect(await describeCall({ chat: "Alice Example" })).toBeUndefined()
    expect(await describeCall({ up_to: 99 })).toBeUndefined()
    expect(await describeCall({ topic: 5 })).toBeUndefined()
  })

  test("gives the same description for the same state", async () => {
    t.theirs()
    expect(await describeCall({})).toEqual(await describeCall({}))
  })
})
