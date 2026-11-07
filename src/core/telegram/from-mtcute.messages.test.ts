import { describe, expect, test } from "bun:test"
import { Long } from "@mtcute/core"
import type { tl } from "@mtcute/core"
import {
  FAKE_DATE,
  FAKE_IDS,
  FAKE_MARKED,
  channelPeer,
  chatPeer,
  fakeBasicGroup,
  fakeBold,
  fakeChannel,
  fakeForwardHeader,
  fakeMentionName,
  fakeMessage,
  fakeReactions,
  fakeReplyHeader,
  fakeServiceMessage,
  fakeSupergroup,
  fakeTextLink,
  fakeTopicReplyHeader,
  fakeUser,
  messageOf,
  userPeer,
} from "./fake-telegram.testing"
import { messageInputOf } from "./from-mtcute"
import type { MessageInput } from "./mirror-input"

const MS = 1000
const alice = fakeUser()
const bob = fakeUser({ id: FAKE_IDS.bot, firstName: "Bob", lastName: undefined, username: "bob_example" })

function inputOf(raw: tl.TypeMessage, ...peers: Parameters<typeof messageOf>[1][]): MessageInput {
  const input = messageInputOf(messageOf(raw, ...peers))
  if (!input) throw new Error("expected a message input")
  return input
}

describe("messageInputOf a text message", () => {
  test("carries what the mirror stores of a private message", () => {
    expect(inputOf(fakeMessage(), alice)).toEqual({
      chat: FAKE_MARKED.alice,
      id: 1,
      topic: null,
      ts: FAKE_DATE * MS,
      fromMe: false,
      sender: FAKE_MARKED.alice,
      senderName: "Alice Example",
      kind: "message",
      body: "hello",
      entities: [],
      media: null,
      action: null,
      reply: null,
      forward: null,
      grouped: null,
      reactions: null,
      edited: null,
      ttl: null,
      viewOnce: false,
      selfDestruct: null,
    })
  })

  test("keeps entity types, offsets and lengths, a link's address and a mentioned user, and drops unknown ones", () => {
    const entities = [
      fakeBold(0, 3),
      fakeTextLink(4, 4, "https://example.test/x"),
      fakeMentionName(9, 3, FAKE_IDS.bot),
      { _: "messageEntityUnknown", offset: 0, length: 1 },
    ] satisfies tl.TypeMessageEntity[]
    const input = inputOf(fakeMessage({ message: "bad link Bob", entities }), alice)
    expect(input.entities).toEqual([
      { type: "bold", offset: 0, length: 3 },
      { type: "text_link", offset: 4, length: 4, url: "https://example.test/x" },
      { type: "text_mention", offset: 9, length: 3, user: FAKE_MARKED.bot },
    ])
  })

  test("is an edit when it has an edit date", () => {
    expect(inputOf(fakeMessage({ editDate: FAKE_DATE + 90 }), alice).edited).toBe((FAKE_DATE + 90) * MS)
  })

  test("carries the chat's auto-delete period", () => {
    expect(inputOf(fakeMessage({ ttlPeriod: 86_400 }), alice).ttl).toBe(86_400)
  })

  test("has no body for an empty text", () => {
    expect(inputOf(fakeMessage({ message: "" }), alice).body).toBeNull()
  })

  test("writes an album's id as the decimal string of its long", () => {
    const groupedId = Long.fromString("-1234567890123456789")
    expect(inputOf(fakeMessage({ groupedId }), alice).grouped).toBe("-1234567890123456789")
  })
})

describe("messageInputOf the sender", () => {
  test("is the account for an outgoing message, with no sender when Telegram names none in a private chat", () => {
    const input = inputOf(fakeMessage({ out: true, fromId: undefined }), alice)
    expect(input).toMatchObject({ fromMe: true, sender: null, senderName: null })
  })

  test("is the named sender in a group", () => {
    const raw = fakeMessage({ peerId: chatPeer(), fromId: userPeer(FAKE_IDS.bot) })
    expect(inputOf(raw, fakeBasicGroup(), bob)).toMatchObject({
      chat: FAKE_MARKED.group,
      sender: FAKE_MARKED.bot,
      senderName: "Bob",
    })
  })

  test("is the channel itself for a post, under the post's signature when it has one", () => {
    const post = fakeMessage({ peerId: channelPeer(FAKE_IDS.channel), fromId: undefined, post: true })
    expect(inputOf(post, fakeChannel())).toMatchObject({ sender: FAKE_MARKED.channel, senderName: "Example Channel" })
    const signed = { ...post, postAuthor: "The Editor" }
    expect(inputOf(signed, fakeChannel())).toMatchObject({ sender: FAKE_MARKED.channel, senderName: "The Editor" })
  })

  test("keeps the id and leaves the name out when the peer did not come along", () => {
    expect(inputOf(fakeMessage({ fromId: userPeer(FAKE_IDS.bot) }), alice)).toMatchObject({
      sender: FAKE_MARKED.bot,
      senderName: null,
    })
  })
})

describe("messageInputOf a chat the mirror does not keep", () => {
  test("is null when the chat peer is missing", () => {
    expect(messageInputOf(messageOf(fakeMessage()))).toBeNull()
  })
  test("is null for a message of a monoforum", () => {
    const monoforum = fakeChannel({ broadcast: false, monoforum: true })
    const raw = fakeMessage({ peerId: channelPeer(FAKE_IDS.channel), fromId: undefined })
    expect(messageInputOf(messageOf(raw, monoforum))).toBeNull()
  })
})

describe("messageInputOf a reply", () => {
  test("names the replied-to message of the same chat", () => {
    expect(inputOf(fakeMessage({ replyTo: fakeReplyHeader({ replyToMsgId: 7 }) }), alice).reply).toEqual({ id: 7 })
  })

  test("keeps the text of a quote, and not the copied text of a plain reply", () => {
    const quote = fakeReplyHeader({ replyToMsgId: 7, quote: true, quoteText: "earlier" })
    expect(inputOf(fakeMessage({ replyTo: quote }), alice).reply).toEqual({ id: 7, quote: "earlier" })
    const plain = fakeReplyHeader({ replyToMsgId: 7, quoteText: "the whole message" })
    expect(inputOf(fakeMessage({ replyTo: plain }), alice).reply).toEqual({ id: 7 })
  })

  test("names the other chat of a reply across chats", () => {
    const replyTo = fakeReplyHeader({
      replyToMsgId: 77,
      replyToPeerId: channelPeer(),
      replyFrom: fakeForwardHeader({ fromId: channelPeer() }),
    })
    expect(inputOf(fakeMessage({ replyTo }), alice).reply).toEqual({ id: 77, chat: FAKE_MARKED.supergroup })
  })

  test("is no reply for a thread of a group that is not a forum", () => {
    const replyTo = fakeReplyHeader({ replyToMsgId: 7, replyToTopId: 3 })
    expect(inputOf(fakeMessage({ replyTo }), alice)).toMatchObject({ topic: null, reply: { id: 7 } })
  })
})

describe("messageInputOf in a forum", () => {
  const forum = fakeSupergroup({ forum: true })
  const inForum = { peerId: channelPeer(), fromId: userPeer() }

  test("sits in the topic it was posted to, and replies to nothing", () => {
    const raw = fakeMessage({ ...inForum, replyTo: fakeTopicReplyHeader(5) })
    expect(inputOf(raw, forum, alice)).toMatchObject({ chat: FAKE_MARKED.supergroup, topic: 5, reply: null })
  })

  test("sits in the topic and names the message it replies to", () => {
    const raw = fakeMessage({ ...inForum, replyTo: fakeTopicReplyHeader(5, 7) })
    expect(inputOf(raw, forum, alice)).toMatchObject({ topic: 5, reply: { id: 7, topic: 5 } })
  })

  test("has no topic in the General topic, where messages carry no topic header", () => {
    expect(inputOf(fakeMessage(inForum), forum, alice)).toMatchObject({ topic: null, reply: null })
  })
})

describe("messageInputOf a forward", () => {
  const forwardedAt = (FAKE_DATE - 600) * MS

  test("names the original sender by id and the time of the original", () => {
    const raw = fakeMessage({ fwdFrom: fakeForwardHeader({ fromId: userPeer(FAKE_IDS.bot) }) })
    expect(inputOf(raw, alice).forward).toEqual({ from: FAKE_MARKED.bot, date: forwardedAt })
  })

  test("names only the name when the sender hides themselves", () => {
    const raw = fakeMessage({ fwdFrom: fakeForwardHeader({ fromId: undefined, fromName: "Hidden Person" }) })
    expect(inputOf(raw, alice).forward).toEqual({ name: "Hidden Person", date: forwardedAt })
  })

  test("names the original post of a channel", () => {
    const fwdFrom = fakeForwardHeader({ fromId: channelPeer(FAKE_IDS.channel), channelPost: 42 })
    expect(inputOf(fakeMessage({ fwdFrom }), alice).forward).toEqual({
      from: FAKE_MARKED.channel,
      date: forwardedAt,
      id: 42,
    })
  })

  test("names the saved message's original id when there is no channel post", () => {
    const fwdFrom = fakeForwardHeader({ savedFromPeer: channelPeer(), savedFromMsgId: 9 })
    expect(inputOf(fakeMessage({ fwdFrom }), alice).forward).toMatchObject({ id: 9 })
  })

  test("is still a forward when the header names no sender", () => {
    const fwdFrom = fakeForwardHeader({ fromId: undefined })
    expect(inputOf(fakeMessage({ fwdFrom }), alice).forward).toEqual({ date: forwardedAt })
  })
})

describe("messageInputOf reactions", () => {
  test("counts each reaction and marks the account's own, even the first chosen", () => {
    const reactions = fakeReactions(
      { emoji: "👍", count: 3, chosen: 0 },
      { emoji: "❤️", count: 1 },
      { emoji: Long.fromNumber(5_000_000_010), count: 2, chosen: 1 },
    )
    expect(inputOf(fakeMessage({ reactions }), alice).reactions).toEqual([
      { emoji: "👍", count: 3, mine: true },
      { emoji: "❤️", count: 1 },
      { emoji: "custom:5000000010", count: 2, mine: true },
    ])
  })

  test("keeps unknown reactions apart from explicitly empty ones", () => {
    expect(inputOf(fakeMessage(), alice).reactions).toBeNull()
    expect(inputOf(fakeMessage({ reactions: fakeReactions() }), alice).reactions).toEqual([])
  })

  test("skips an unreadable reaction without losing a valid one", () => {
    const reactions = fakeReactions({ emoji: "👍", count: 3 })
    reactions.results.unshift({ _: "reactionCount", count: 1, reaction: { _: "reactionEmpty" } })
    expect(inputOf(fakeMessage({ reactions }), alice).reactions).toEqual([{ emoji: "👍", count: 3 }])
  })
})

describe("messageInputOf a service message", () => {
  const inGroup = { peerId: chatPeer(), fromId: userPeer() }

  function actionOf(action: tl.TypeMessageAction, overrides: Partial<tl.RawMessageService> = {}) {
    return inputOf(fakeServiceMessage(action, { ...inGroup, ...overrides }), fakeBasicGroup(), alice, bob).action
  }

  test("is a service message with no body, text or media, and its action", () => {
    const input = inputOf(fakeServiceMessage({ _: "messageActionPinMessage" }), alice)
    expect(input).toMatchObject({
      kind: "service",
      body: null,
      entities: [],
      media: null,
      action: { type: "message_pinned" },
    })
  })

  test("names the pinned message by its reply", () => {
    const raw = fakeServiceMessage({ _: "messageActionPinMessage" }, { replyTo: fakeReplyHeader({ replyToMsgId: 4 }) })
    expect(inputOf(raw, alice).reply).toEqual({ id: 4 })
  })

  test("keeps the title and the users of a new group", () => {
    const action = actionOf({
      _: "messageActionChatCreate",
      title: "Example Group",
      users: [FAKE_IDS.me, FAKE_IDS.alice],
    })
    expect(action).toEqual({ type: "chat_created", title: "Example Group", users: [FAKE_MARKED.me, FAKE_MARKED.alice] })
  })

  test("keeps the users added, the user removed and the inviter of a link", () => {
    expect(actionOf({ _: "messageActionChatAddUser", users: [FAKE_IDS.bot] })).toEqual({
      type: "users_added",
      users: [FAKE_MARKED.bot],
    })
    expect(actionOf({ _: "messageActionChatDeleteUser", userId: FAKE_IDS.bot })).toEqual({
      type: "user_removed",
      users: [FAKE_MARKED.bot],
    })
    expect(actionOf({ _: "messageActionChatJoinedByLink", inviterId: FAKE_IDS.bot })).toEqual({
      type: "user_joined_link",
      users: [FAKE_MARKED.bot],
    })
  })

  test("is a user leaving when the user removed is the sender", () => {
    expect(actionOf({ _: "messageActionChatDeleteUser", userId: FAKE_IDS.alice })).toEqual({ type: "user_left" })
  })

  test("keeps the new title and the new auto-delete period", () => {
    expect(actionOf({ _: "messageActionChatEditTitle", title: "Renamed Group" })).toEqual({
      type: "title_changed",
      title: "Renamed Group",
    })
    expect(actionOf({ _: "messageActionSetMessagesTTL", period: 604_800 })).toEqual({
      type: "ttl_changed",
      period: 604_800,
    })
  })

  test("keeps the title of a topic created or edited", () => {
    expect(actionOf({ _: "messageActionTopicCreate", title: "New Topic", iconColor: 1 })).toEqual({
      type: "topic_created",
      title: "New Topic",
    })
    expect(actionOf({ _: "messageActionTopicEdit", title: "Renamed Topic", closed: true })).toEqual({
      type: "topic_edited",
      title: "Renamed Topic",
    })
    expect(actionOf({ _: "messageActionTopicEdit", closed: true })).toEqual({ type: "topic_edited" })
  })

  test("keeps Telegram's own name for an action mtcute does not know", () => {
    expect(actionOf({ _: "messageActionEmpty" })).toEqual({ type: "messageActionEmpty" })
  })

  test("keeps the type alone for an action with no small fields", () => {
    expect(actionOf({ _: "messageActionHistoryClear" })).toEqual({ type: "history_cleared" })
  })
})
