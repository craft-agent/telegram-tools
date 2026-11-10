import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { ServiceCalls } from "../chat/read.testing"
import { upsertTopics } from "../telegram/ingest-chats"
import { recordDeleted } from "../telegram/mirror-rows"
import { NOW, OTHER_USER, SUPERGROUP, USER } from "../telegram/mirror.testing"
import { createActionFixture, OWN_ID, THEIR_ID, type ActionFixture } from "./action.testing"

let t: ActionFixture
let calls: ServiceCalls

/** The topic of the forum `SUPERGROUP`, and the messages of it that the tests mark read up to. */
const TOPIC = 5
const IN_TOPIC = 21
const IN_GENERAL = 22

beforeEach(async () => {
  t = createActionFixture()
  calls = await t.serveMarkRead()
})

afterEach(async () => {
  await t.stopServices()
  t.close()
})

/** Follows the forum `SUPERGROUP`, with a message in `TOPIC` and one in the General topic. */
function withForum(): void {
  t.follow({ id: SUPERGROUP, kind: "supergroup", name: "Old Friends", username: null, forum: true })
  upsertTopics(t.mirror, [{ chat: SUPERGROUP, id: TOPIC, title: "Talk" }], NOW)
  t.store({ chat: SUPERGROUP, id: IN_TOPIC, topic: TOPIC }, { chat: SUPERGROUP, id: IN_GENERAL, topic: null })
}

describe("mark read: the mirror is checked before any request", () => {
  test("a chat the mirror lacks is not found", async () => {
    t.theirs()
    const error = await t.markReadFails({ chat: OTHER_USER })
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("No chat with this id")
    expect(calls).toHaveLength(0)
  })

  test("a message the mirror lacks is not found, in the words of a read mark", async () => {
    t.theirs()
    expect(await t.markReadFails({ up_to: 99 })).toMatchObject({
      code: "not_found",
      message: "No message 99 in this chat; nothing was marked read.",
    })
    expect(calls).toHaveLength(0)
  })

  test("a message of a chat the mirror does not keep cannot be checked", async () => {
    t.known({ id: SUPERGROUP, kind: "supergroup", name: "Old Friends", username: null })
    const error = await t.markReadFails({ chat: SUPERGROUP })
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("not mirrored")
    expect(calls).toHaveLength(0)
  })

  test("a chat the user has left is forbidden", async () => {
    t.follow({ left: true })
    expect(await t.markReadFails()).toMatchObject({
      code: "forbidden",
      message: "You are no longer in this chat; nothing was marked read.",
    })
    expect(calls).toHaveLength(0)
  })

  test("a message the mirror has as deleted is not found", async () => {
    t.theirs()
    recordDeleted(t.mirror, USER, 99, NOW)
    expect(await t.markReadFails({ up_to: 99 })).toMatchObject({
      code: "not_found",
      message: "This message was deleted; nothing was marked read.",
    })
    expect(calls).toHaveLength(0)
  })

  test("a topic in a chat without topics is invalid", async () => {
    t.theirs()
    expect(await t.markReadFails({ topic: TOPIC })).toMatchObject({
      code: "invalid_argument",
      message: "This chat has no topics; nothing was marked read.",
    })
    expect(calls).toHaveLength(0)
  })

  test("a message outside the topic is invalid, whether it is another topic's or the General topic's", async () => {
    withForum()
    for (const args of [
      { up_to: IN_GENERAL, topic: TOPIC },
      { up_to: IN_TOPIC, topic: 1 },
      { up_to: IN_TOPIC, topic: 9 },
    ]) {
      expect(await t.markReadFails({ chat: SUPERGROUP, ...args })).toMatchObject({
        code: "invalid_argument",
        message: "This message is not in that topic; nothing was marked read.",
      })
    }
    expect(calls).toHaveLength(0)
  })
})

describe("mark read: what the mirror allows goes to the service", () => {
  test("a message of anyone's, the user's own included", async () => {
    t.theirs()
    t.store({ id: OWN_ID, fromMe: true, sender: null, body: "old text" })
    await t.markRead()
    await t.markRead({ up_to: OWN_ID })
    expect(calls.map(({ params }) => params)).toEqual([
      { chat: USER, up_to: THEIR_ID },
      { chat: USER, up_to: OWN_ID },
    ])
  })

  test("a message of the topic, and of the General topic with its id 1", async () => {
    withForum()
    await t.markRead({ chat: SUPERGROUP, up_to: IN_TOPIC, topic: TOPIC })
    await t.markRead({ chat: SUPERGROUP, up_to: IN_GENERAL, topic: 1 })
    expect(calls.map(({ params }) => params)).toEqual([
      { chat: SUPERGROUP, up_to: IN_TOPIC, topic: TOPIC },
      { chat: SUPERGROUP, up_to: IN_GENERAL, topic: 1 },
    ])
  })

  test("a service message", async () => {
    t.theirs({ id: 9, kind: "service", body: null, action: { type: "pin" } })
    await t.markRead({ up_to: 9 })
    expect(calls).toHaveLength(1)
  })
})
