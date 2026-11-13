import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { GROUP, OTHER_USER, SUPERGROUP, USER } from "../telegram/mirror.testing"
import { formatLocalTime } from "../time"
import { invoke } from "../tool"
import { excludingContext } from "./excluded.testing"
import { telegramChatRead } from "./read"
import { at, createChatFixture, liveMessage, type ChatFixture } from "./read.testing"

let t: ChatFixture

beforeEach(() => {
  t = createChatFixture()
  t.follow({ id: USER, name: "Alice Example" })
  t.known({ id: OTHER_USER, name: "Bob Example", username: null })
  t.follow({ id: GROUP, kind: "group", name: "Team Chat", username: null })
})

afterEach(async () => {
  await t.stopServices()
  t.close()
})

/** The messages of `chat` as `view` returns them under a setting that excludes `excluded`. */
async function viewWithout(excluded: string[], chat = USER) {
  const page = await invoke(telegramChatRead, { method: "view", chat }, excludingContext(t.stateDir, excluded))
  return page.messages ?? []
}

describe("chat read: a message that points at an excluded chat", () => {
  test("a reply to a message there keeps its ids, topic and quote and shows no text, nor a private note", async () => {
    t.store(
      { chat: GROUP, id: 1, body: "the secret", viewOnce: true },
      { chat: USER, id: 1, body: "answer", reply: { id: 1, chat: GROUP, topic: 5, quote: "the sec" } },
    )
    const [open] = await t.messages(USER)
    expect(open?.reply_to).toEqual({ id: 1, chat: GROUP, topic: 5, quote: "the sec", text: "the secret" })
    expect(open).toHaveProperty("private_note")
    const [closed] = await viewWithout([GROUP])
    expect(closed?.reply_to).toEqual({ id: 1, chat: GROUP, topic: 5, quote: "the sec" })
    expect(closed).not.toHaveProperty("private_note")
  })

  test("a reply inside the allowed chat keeps its text", async () => {
    t.store({ id: 1, body: "question" }, { id: 2, body: "answer", reply: { id: 1 } })
    const [, answer] = await viewWithout([GROUP, OTHER_USER])
    expect(answer?.reply_to).toEqual({ id: 1, text: "question" })
  })

  test("a forward from it keeps its id and the name its header holds, and looks no name up", async () => {
    t.store(
      { id: 1, forward: { from: OTHER_USER, date: at(-4) } },
      { id: 2, forward: { from: OTHER_USER, name: "Hidden Sender", date: at(-3) } },
    )
    const [byId, byName] = await t.messages(USER)
    expect(byId?.forwarded_from).toEqual({ id: OTHER_USER, name: "Bob Example", time: formatLocalTime(at(-4)) })
    const [withheld, named] = await viewWithout([OTHER_USER])
    expect(withheld?.forwarded_from).toEqual({ id: OTHER_USER, time: formatLocalTime(at(-4)) })
    expect(named?.forwarded_from).toEqual({ id: OTHER_USER, name: "Hidden Sender", time: formatLocalTime(at(-3)) })
    expect(byName?.forwarded_from?.name).toBe("Hidden Sender")
  })

  test("a message sent by it keeps the sender's id and the name sent with it, and looks no name up", async () => {
    t.store(
      { chat: GROUP, id: 1, sender: OTHER_USER, senderName: null },
      { chat: GROUP, id: 2, sender: OTHER_USER, senderName: "Bob Sent As" },
    )
    const [open] = await t.messages(GROUP)
    expect(open).toMatchObject({ from: "Bob Example", from_id: OTHER_USER })
    const [withheld, named] = await viewWithout([OTHER_USER], GROUP)
    expect(withheld).toMatchObject({ from: "unknown", from_id: OTHER_USER })
    expect(named).toMatchObject({ from: "Bob Sent As", from_id: OTHER_USER })
  })

  test("a live read keeps the same bounds", async () => {
    t.known({ id: SUPERGROUP, kind: "supergroup", name: "Old Friends", username: null })
    t.store({ chat: GROUP, id: 1, body: "the secret" })
    await t.serve({
      history: () => ({
        messages: [
          liveMessage({ id: 1, ts: at(1), body: "answer", reply: { id: 1, chat: GROUP, quote: "the sec" } }),
          liveMessage({ id: 2, ts: at(2), body: "from Bob", sender: OTHER_USER, senderName: null }),
        ].reverse(),
        more: false,
      }),
    })
    const ctx = excludingContext(t.stateDir, [GROUP, OTHER_USER])
    const page = await invoke(telegramChatRead, { method: "view", chat: SUPERGROUP }, ctx)
    expect(page.live).toBe(true)
    expect(page.messages?.[0]?.reply_to).toEqual({ id: 1, chat: GROUP, quote: "the sec" })
    expect(page.messages?.[1]).toMatchObject({ from: "unknown", from_id: OTHER_USER })
  })
})
