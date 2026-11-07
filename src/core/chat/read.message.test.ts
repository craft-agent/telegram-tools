import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { CHANNEL, GROUP, OTHER_USER, SUPERGROUP, USER } from "../telegram/mirror.testing"
import { formatLocalTime } from "../time"
import { at, createChatFixture, type ChatFixture } from "./read.testing"

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

let t: ChatFixture

beforeEach(() => {
  t = createChatFixture()
  t.follow({ id: USER, name: "Alice Example" })
})

afterEach(() => {
  t.close()
})

async function only(chat = USER): Promise<Awaited<ReturnType<ChatFixture["messages"]>>[number]> {
  const [message, ...rest] = await t.messages(chat)
  expect(rest).toEqual([])
  if (!message) throw new Error("expected a message")
  return message
}

describe("chat read: who a message is from", () => {
  test("the name sent with the message comes first, and the sender's id is the marked id", async () => {
    t.store({ senderName: "Alice Sent As" })
    expect(await only()).toMatchObject({ from: "Alice Sent As", from_id: USER })
  })

  test("else the name of the sender's chat in the mirror", async () => {
    t.known({ id: OTHER_USER, name: "Bob Example" })
    t.store({ sender: OTHER_USER, senderName: null })
    expect(await only()).toMatchObject({ from: "Bob Example", from_id: OTHER_USER })
  })

  test("else, for a post of a channel, the channel's name, with or without the channel as sender", async () => {
    t.follow({ id: CHANNEL, kind: "channel", name: "News" })
    t.store(
      { chat: CHANNEL, id: 1, sender: CHANNEL, senderName: null },
      { chat: CHANNEL, id: 2, sender: null, senderName: null },
      { chat: CHANNEL, id: 3, sender: CHANNEL, senderName: "Editor" },
    )
    const [first, second, third] = await t.messages(CHANNEL)
    expect(first).toMatchObject({ from: "News", from_id: CHANNEL })
    expect(second).toMatchObject({ from: "News" })
    expect(second).not.toHaveProperty("from_id")
    expect(third).toMatchObject({ from: "Editor" })
  })

  test("else unknown, and the user's own messages are me with no sender id", async () => {
    t.follow({ id: GROUP, kind: "group", name: "Team Chat" })
    t.store(
      { chat: GROUP, id: 1, sender: "1000000099", senderName: null },
      { chat: GROUP, id: 2, sender: null, senderName: null },
      { chat: GROUP, id: 3, fromMe: true, sender: USER, senderName: "Alice Example" },
    )
    const [stranger, nobody, mine] = await t.messages(GROUP)
    expect(stranger).toMatchObject({ from: "unknown", from_id: "1000000099" })
    expect(nobody).toMatchObject({ from: "unknown" })
    expect(nobody).not.toHaveProperty("from_id")
    expect(mine).toMatchObject({ from: "me" })
    expect(mine).not.toHaveProperty("from_id")
  })

  test("a message of a forum topic names the topic", async () => {
    t.follow({ id: SUPERGROUP, kind: "supergroup", name: "Old Friends", forum: true })
    t.store({ chat: SUPERGROUP, id: 1, topic: 17 }, { chat: SUPERGROUP, id: 2, topic: null })
    const [inTopic, general] = await t.messages(SUPERGROUP)
    expect(inTopic?.topic).toBe(17)
    expect(general).not.toHaveProperty("topic")
  })

  test("a message without any of the optional parts has none of their fields", async () => {
    t.store({ body: "plain" })
    expect(Object.keys(await only()).sort()).toEqual(["from", "from_id", "id", "text", "time"])
  })
})

describe("chat read: what a message carries", () => {
  test("the text is returned as it was stored, and a message of media only has no text", async () => {
    t.store({ id: 1, body: "  Ünïcode 🙂 — as sent \n" }, { id: 2, body: null, media: { type: "photo" } })
    const [first, second] = await t.messages(USER)
    expect(first?.text).toBe("  Ünïcode 🙂 — as sent \n")
    expect(second).not.toHaveProperty("text")
  })

  test("links are the words a text link covers and where it leads, counted in UTF-16 units", async () => {
    const body = "😀 read the docs 👍👍 and the faq"
    const docs = body.indexOf("the docs")
    const faq = body.indexOf("the faq")
    expect([docs, faq]).toEqual([8, 26])
    t.store({
      body,
      entities: [
        { type: "bold", offset: 0, length: 2 },
        { type: "text_link", offset: docs, length: 8, url: "https://example.com/docs" },
        { type: "url", offset: 0, length: 1 },
        { type: "text_link", offset: faq, length: 7, url: "https://example.com/faq" },
      ],
    })
    expect((await only()).links).toEqual([
      { text: "the docs", url: "https://example.com/docs" },
      { text: "the faq", url: "https://example.com/faq" },
    ])
  })

  test("media is returned as stored, with no path or file id", async () => {
    const media = {
      type: "photo",
      name: "cat.png",
      mime: "image/png",
      size: 123,
      duration: 4,
      width: 640,
      height: 480,
      emoji: "🐱",
      spoiler: true as const,
      title: "A cat",
      url: "https://example.com/cat",
      question: "Cat or dog?",
      what: "a poll",
    }
    t.store({ body: "see", media })
    const message = await only()
    expect(message.media).toEqual(media)
    expect(JSON.stringify(message)).not.toMatch(/file_id|path|access_hash/)
  })

  test("a reply carries its ids, topic and quote, and the text of the message replied to from the mirror", async () => {
    t.store(
      { id: 1, body: "the question" },
      { id: 2, body: "answer", reply: { id: 1, topic: 5, quote: "the quest" } },
      { id: 3, body: "unknown target", reply: { id: 99 } },
    )
    const [, answer, unknown] = await t.messages(USER)
    expect(answer?.reply_to).toEqual({ id: 1, topic: 5, quote: "the quest", text: "the question" })
    expect(unknown?.reply_to).toEqual({ id: 99 })
  })

  test("a reply to another chat looks the text up there", async () => {
    t.follow({ id: GROUP, kind: "group", name: "Team Chat" })
    t.store(
      { chat: GROUP, id: 1, body: "in the group" },
      { chat: USER, id: 1, body: "elsewhere", reply: { id: 1, chat: GROUP } },
      { chat: USER, id: 2, body: "same id here", reply: { id: 1 } },
    )
    const [elsewhere, here] = await t.messages(USER)
    expect(elsewhere?.reply_to).toEqual({ id: 1, chat: GROUP, text: "in the group" })
    expect(here?.reply_to).toEqual({ id: 1, text: "elsewhere" })
  })

  test("the text replied to is cut at 200 characters, never inside a pair, and says so", async () => {
    const long = `a${"😀".repeat(150)}`
    t.store(
      { id: 1, body: "x".repeat(300) },
      { id: 2, body: long },
      { id: 3, body: "x".repeat(200) },
      { id: 4, body: "to long", reply: { id: 1 } },
      { id: 5, body: "to emoji", reply: { id: 2 } },
      { id: 6, body: "to exact", reply: { id: 3 } },
    )
    const [, , , cut, emoji, exact] = await t.messages(USER)
    expect(cut?.reply_to).toEqual({ id: 1, text: "x".repeat(200), text_cut: true })
    expect(emoji?.reply_to?.text_cut).toBe(true)
    expect(long.startsWith(emoji?.reply_to?.text ?? "x")).toBe(true)
    expect(emoji?.reply_to?.text?.length).toBe(199)
    expect(LONE_SURROGATE.test(emoji?.reply_to?.text ?? "")).toBe(false)
    expect(exact?.reply_to).toEqual({ id: 3, text: "x".repeat(200) })
  })

  test("a forward names the original sender by the name sent, else by the mirror's name for the id, with its time", async () => {
    t.known({ id: OTHER_USER, name: "Bob Example" })
    t.store(
      { id: 1, forward: { name: "Hidden Sender", date: at(-5) } },
      { id: 2, forward: { from: OTHER_USER, date: at(-4), id: 77 } },
      { id: 3, forward: { from: "1000000099" } },
      { id: 4, forward: {} },
    )
    const [byName, byId, unknown, bare] = await t.messages(USER)
    expect(byName?.forwarded_from).toEqual({ name: "Hidden Sender", time: formatLocalTime(at(-5)) })
    expect(byId?.forwarded_from).toEqual({ id: OTHER_USER, name: "Bob Example", time: formatLocalTime(at(-4)) })
    expect(unknown?.forwarded_from).toEqual({ id: "1000000099" })
    expect(bare?.forwarded_from).toEqual({})
  })

  test("the messages of an album share its id", async () => {
    t.store({ id: 1, grouped: "13847" }, { id: 2, grouped: "13847" }, { id: 3 })
    const [first, second, third] = await t.messages(USER)
    expect([first?.album, second?.album]).toEqual(["13847", "13847"])
    expect(third).not.toHaveProperty("album")
  })

  test("reactions are returned as stored, and a cleared list leaves none", async () => {
    t.store({
      id: 1,
      reactions: [
        { emoji: "👍", count: 3, mine: true },
        { emoji: "custom:55", count: 1 },
      ],
    })
    t.store({ id: 2, reactions: [] })
    const [first, second] = await t.messages(USER)
    expect(first?.reactions).toEqual([
      { emoji: "👍", count: 3, mine: true },
      { emoji: "custom:55", count: 1 },
    ])
    expect(second).not.toHaveProperty("reactions")
  })

  test("a service message carries its event, and no text of its own", async () => {
    t.follow({ id: GROUP, kind: "group", name: "Team Chat" })
    t.store(
      { chat: GROUP, id: 1, kind: "service", body: null, action: { type: "users_added", users: [USER, OTHER_USER] } },
      { chat: GROUP, id: 2, kind: "service", body: null, action: { type: "title_changed", title: "Team" } },
      { chat: GROUP, id: 3, kind: "service", body: null, action: { type: "ttl_changed", period: 86_400 } },
      { chat: GROUP, id: 4, kind: "service", body: null },
    )
    const [added, titled, ttl, bare] = await t.messages(GROUP)
    expect(added?.event).toEqual({ type: "users_added", users: [USER, OTHER_USER] })
    expect(titled?.event).toEqual({ type: "title_changed", title: "Team" })
    expect(ttl?.event).toEqual({ type: "ttl_changed", period: 86_400 })
    expect(bare).not.toHaveProperty("event")
    expect(added).not.toHaveProperty("text")
  })
})

describe("chat read: edits", () => {
  const first = at(0)

  test("an edited message shows its latest version and every earlier one, oldest first, each with when it was written", async () => {
    t.store({ id: 1, ts: first, body: "v1", media: { type: "photo" } })
    t.store({ id: 1, ts: first, body: "v2", edited: first + 1000 })
    t.store({ id: 1, ts: first, body: "v3", edited: first + 5000 })
    const message = await only()
    expect(message.text).toBe("v3")
    expect(message.edited_at).toBe(formatLocalTime(first + 5000))
    expect(message.earlier_versions).toEqual([
      { time: formatLocalTime(first), text: "v1", media: { type: "photo" } },
      { time: formatLocalTime(first + 1000), text: "v2" },
    ])
    expect(message).not.toHaveProperty("media")
  })

  test("an unedited message, and one whose edit changed nothing, has no earlier versions", async () => {
    t.store({ id: 1, ts: first, body: "same" })
    t.store({ id: 1, ts: first, body: "same", edited: null })
    const message = await only()
    expect(message).not.toHaveProperty("edited_at")
    expect(message).not.toHaveProperty("earlier_versions")
  })

  test("the versions of each message stay with it", async () => {
    t.store({ id: 1, ts: first, body: "a1" }, { id: 2, ts: first + 1, body: "b1" })
    t.store({ id: 2, ts: first + 1, body: "b2", edited: first + 10 })
    t.store({ id: 1, ts: first, body: "a2", edited: first + 20 })
    const [a, b] = await t.messages(USER)
    expect(a?.earlier_versions?.map((version) => version.text)).toEqual(["a1"])
    expect(b?.earlier_versions?.map((version) => version.text)).toEqual(["b1"])
  })
})
