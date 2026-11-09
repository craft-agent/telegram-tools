import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { callDescription } from "../describe"
import { upsertTopics } from "../telegram/ingest-chats"
import { OTHER_USER, SUPERGROUP, USER } from "../telegram/mirror.testing"
import { DOWNLOAD_CONTEXT } from "../tool.testing"
import { telegramMessageSend } from "./send"
import { createSendFixture, type SendFixture } from "./send.testing"

let t: SendFixture

beforeEach(() => {
  t = createSendFixture()
})

afterEach(async () => {
  await t.stopServices()
  t.close()
})

const context = () => ({ cwd: t.stateDir, stateDir: t.stateDir, ...DOWNLOAD_CONTEXT })
const describeCall = (args: object) => callDescription(telegramMessageSend, args, context())

describe("send: the approval description", () => {
  test("states the intent", () => {
    expect(telegramMessageSend.intent).toBe("About to send a message")
  })

  test("names a person by the mirror's name and shows the trimmed text", async () => {
    t.known({ id: USER, kind: "user", name: "Alice Example" })
    expect(await describeCall({ chat: USER, text: "  hello  " })).toEqual({
      headline: { text: "About to send a message to {chat}", values: { chat: "Alice Example" } },
      facts: [{ label: "Chat", value: { text: "Person" } }],
      text: { label: "Message text", body: "hello" },
    })
  })

  test("adds the topic's title and the reply in order after the kind of chat", async () => {
    t.known({ id: SUPERGROUP, kind: "supergroup", name: "Old Friends", username: null })
    upsertTopics(t.mirror, [{ chat: SUPERGROUP, id: 5, title: "Talk" }], 1)
    expect(await describeCall({ chat: SUPERGROUP, text: "hi", topic: 5, reply_to: 42 })).toEqual({
      headline: { text: "About to send a message to {chat}", values: { chat: "Old Friends" } },
      facts: [
        { label: "Chat", value: { text: "Supergroup" } },
        { label: "Topic", value: "Talk" },
        { label: "Reply to", value: { text: "message {id}", values: { id: 42 } } },
      ],
      text: { label: "Message text", body: "hi" },
    })
  })

  test("shows the id of a topic the mirror does not know", async () => {
    t.known({ id: SUPERGROUP, kind: "supergroup", name: "Old Friends", username: null })
    const description = await describeCall({ chat: SUPERGROUP, text: "hi", topic: 9 })
    expect(description?.facts[1]).toEqual({ label: "Topic", value: "9" })
  })

  test("gives no headline for a chat without a name, and keeps the facts", async () => {
    t.known({ id: OTHER_USER, kind: "user", name: null, username: null })
    const description = await describeCall({ chat: OTHER_USER, text: "hi" })
    expect(description?.headline).toBeUndefined()
    expect(description?.facts).toEqual([{ label: "Chat", value: { text: "Person" } }])
  })

  test("gives no description for a chat the mirror lacks, a name, or a blank text", async () => {
    t.known({ id: USER, kind: "user", name: "Alice Example" })
    expect(await describeCall({ chat: OTHER_USER, text: "hi" })).toBeUndefined()
    expect(await describeCall({ chat: "Alice Example", text: "hi" })).toBeUndefined()
    expect(await describeCall({ chat: USER, text: "   " })).toBeUndefined()
  })

  test("gives the same description for the same state", async () => {
    t.known({ id: USER, kind: "user", name: "Alice Example" })
    expect(await describeCall({ chat: USER, text: "hi", reply_to: 3 })).toEqual(
      await describeCall({ chat: USER, text: "hi", reply_to: 3 }),
    )
  })
})
