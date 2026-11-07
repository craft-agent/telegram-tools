import { describe, expect, test } from "bun:test"
import { Chat, DeleteMessageUpdate, Dialog, ForumTopic, HistoryReadUpdate, User } from "@mtcute/core"
import {
  FAKE_DATE,
  FAKE_IDS,
  FAKE_MARKED,
  channelPeer,
  chatPeer,
  dialogMessages,
  fakeBasicGroup,
  fakeBot,
  fakeChannel,
  fakeChannelReadUpdate,
  fakeCommunity,
  fakeDeleteUpdate,
  fakeDialog,
  fakeForbiddenChannel,
  fakeForbiddenGroup,
  fakeForumTopic,
  fakeMessage,
  fakeOutboxReadUpdate,
  fakeReadUpdate,
  fakeReplyHeader,
  fakeSelf,
  fakeServiceMessage,
  fakeSupergroup,
  fakeThreadReadUpdate,
  fakeTopicReplyHeader,
  fakeUser,
  messageOf,
  peersOf,
} from "./fake-telegram.testing"
import {
  chatInputOf,
  chatInputOfDialog,
  deleteInputOf,
  readInputOf,
  topicInputOf,
  topicInputOfAction,
} from "./from-mtcute"

describe("chatInputOf a person", () => {
  test("is a user with the display name and username", () => {
    expect(chatInputOf(new User(fakeUser()))).toEqual({
      id: FAKE_MARKED.alice,
      kind: "user",
      name: "Alice Example",
      username: "alice_example",
    })
  })

  test("is `self` for the account itself", () => {
    expect(chatInputOf(new User(fakeSelf()))).toEqual({
      id: FAKE_MARKED.me,
      kind: "self",
      name: "Me Example",
      username: "me_example",
    })
  })

  test("is a bot for a bot, and keeps a missing username as null", () => {
    expect(chatInputOf(new User(fakeBot({ username: undefined })))).toEqual({
      id: FAKE_MARKED.bot,
      kind: "bot",
      name: "Example Bot",
      username: null,
    })
  })

  test("never carries the phone number", () => {
    expect(JSON.stringify(chatInputOf(new User(fakeUser())))).not.toContain("5550100")
  })
})

describe("chatInputOf a group", () => {
  test("is a group for a basic group, under its negative id", () => {
    expect(chatInputOf(new Chat(fakeBasicGroup()))).toEqual({
      id: FAKE_MARKED.group,
      kind: "group",
      name: "Example Group",
      username: null,
      forum: false,
      left: false,
    })
  })

  test("is a supergroup under its marked id, with its username", () => {
    expect(chatInputOf(new Chat(fakeSupergroup({ username: "example_supergroup" })))).toEqual({
      id: FAKE_MARKED.supergroup,
      kind: "supergroup",
      name: "Example Supergroup",
      username: "example_supergroup",
      forum: false,
      left: false,
    })
  })

  test("is a forum for a supergroup with topics", () => {
    expect(chatInputOf(new Chat(fakeSupergroup({ forum: true })))).toMatchObject({ kind: "supergroup", forum: true })
  })

  test("is a supergroup for a gigagroup", () => {
    expect(chatInputOf(new Chat(fakeSupergroup({ gigagroup: true })))).toMatchObject({ kind: "supergroup" })
  })

  test("is a channel for a broadcast channel", () => {
    expect(chatInputOf(new Chat(fakeChannel()))).toEqual({
      id: FAKE_MARKED.channel,
      kind: "channel",
      name: "Example Channel",
      username: null,
      forum: false,
      left: false,
    })
  })

  test("is null for a monoforum and for a community", () => {
    expect(chatInputOf(new Chat(fakeChannel({ broadcast: false, monoforum: true })))).toBeNull()
    expect(chatInputOf(new Chat(fakeCommunity()))).toBeNull()
  })
})

describe("chatInputOf a group the account is out of", () => {
  test("is left when the account left a channel or supergroup", () => {
    expect(chatInputOf(new Chat(fakeChannel({ left: true })))).toMatchObject({ left: true })
    expect(chatInputOf(new Chat(fakeSupergroup({ left: true })))).toMatchObject({ left: true })
  })

  test("is left when a basic group was left or deactivated", () => {
    expect(chatInputOf(new Chat(fakeBasicGroup({ left: true })))).toMatchObject({ left: true })
    expect(chatInputOf(new Chat(fakeBasicGroup({ deactivated: true })))).toMatchObject({ left: true })
  })

  test("is left, with its title, when Telegram forbids it", () => {
    expect(chatInputOf(new Chat(fakeForbiddenGroup()))).toEqual({
      id: FAKE_MARKED.group,
      kind: "group",
      name: "Example Group",
      username: null,
      forum: false,
      left: true,
    })
    expect(chatInputOf(new Chat(fakeForbiddenChannel()))).toMatchObject({ kind: "channel", left: true })
  })

  test("says nothing about leaving when it is only a stub", () => {
    const input = chatInputOf(new Chat(fakeSupergroup({ min: true, left: true })))
    expect(input).not.toBeNull()
    expect(input).not.toHaveProperty("left")
  })
})

describe("chatInputOfDialog", () => {
  const alice = fakeUser()
  const newest = fakeMessage({ id: 9, date: FAKE_DATE })

  function dialogOf(raw = fakeDialog(), ...messages: ReturnType<typeof fakeMessage>[]) {
    return new Dialog(
      raw,
      peersOf(alice, fakeSupergroup(), fakeChannel(), fakeBasicGroup()),
      dialogMessages(...messages),
    )
  }

  test("adds the unread count, read position, newest message and archive state to the peer", () => {
    expect(chatInputOfDialog(dialogOf(fakeDialog(), newest))).toEqual({
      id: FAKE_MARKED.alice,
      kind: "user",
      name: "Alice Example",
      username: "alice_example",
      archived: false,
      unread: 2,
      readMax: 8,
      topId: 9,
      lastTs: FAKE_DATE * 1000,
      ttl: null,
    })
  })

  test("is archived in folder 1 and carries the chat's auto-delete period", () => {
    const input = chatInputOfDialog(dialogOf(fakeDialog(undefined, { folderId: 1, ttlPeriod: 86_400 }), newest))
    expect(input).toMatchObject({ archived: true, ttl: 86_400 })
  })

  test("has no newest time when the list brought no message, and no id for an empty chat", () => {
    expect(chatInputOfDialog(dialogOf())).toMatchObject({ topId: 9, lastTs: null })
    expect(chatInputOfDialog(dialogOf(fakeDialog(undefined, { topMessage: 0 })))).toMatchObject({ topId: null })
  })

  test("keeps the group's own fields", () => {
    const input = chatInputOfDialog(dialogOf(fakeDialog(chatPeer())))
    expect(input).toMatchObject({ id: FAKE_MARKED.group, kind: "group", left: false })
    expect(chatInputOfDialog(dialogOf(fakeDialog(channelPeer(FAKE_IDS.channel))))).toMatchObject({ kind: "channel" })
  })

  test("is null for a chat the mirror does not keep", () => {
    const monoforum = fakeChannel({ broadcast: false, monoforum: true })
    const dialog = new Dialog(fakeDialog(channelPeer(FAKE_IDS.channel)), peersOf(monoforum), dialogMessages())
    expect(chatInputOfDialog(dialog)).toBeNull()
  })

  test("is null when the dialog peer is missing", () => {
    expect(chatInputOfDialog(new Dialog(fakeDialog(), peersOf(), dialogMessages()))).toBeNull()
  })
})

describe("deleteInputOf", () => {
  test("names no chat for an update without a channel", () => {
    expect(deleteInputOf(new DeleteMessageUpdate(fakeDeleteUpdate([3, 4])))).toEqual({ chat: null, ids: [3, 4] })
  })

  test("names the marked id of the channel or supergroup", () => {
    const update = new DeleteMessageUpdate(fakeDeleteUpdate([7], FAKE_IDS.supergroup))
    expect(deleteInputOf(update)).toEqual({ chat: FAKE_MARKED.supergroup, ids: [7] })
  })
})

describe("readInputOf", () => {
  test("is the incoming read position of a private chat, with what is left unread", () => {
    expect(readInputOf(new HistoryReadUpdate(fakeReadUpdate()))).toEqual({
      chat: FAKE_MARKED.alice,
      maxId: 10,
      unread: 2,
    })
  })

  test("is the incoming read position of a supergroup under its marked id", () => {
    expect(readInputOf(new HistoryReadUpdate(fakeChannelReadUpdate()))).toEqual({
      chat: FAKE_MARKED.supergroup,
      maxId: 10,
      unread: 2,
    })
  })

  test("is null for a read of the account's own messages", () => {
    expect(readInputOf(new HistoryReadUpdate(fakeOutboxReadUpdate()))).toBeNull()
  })

  test("is null for a read inside a thread or topic", () => {
    expect(readInputOf(new HistoryReadUpdate(fakeThreadReadUpdate()))).toBeNull()
    expect(readInputOf(new HistoryReadUpdate(fakeReadUpdate({ topMsgId: 5 })))).toBeNull()
  })
})

describe("topicInputOf", () => {
  const peers = peersOf(fakeSupergroup({ forum: true }), fakeUser())

  test("needs no resolved peers for the topic's raw chat id", () => {
    expect(topicInputOf(new ForumTopic(fakeForumTopic(), peersOf()))).toEqual({
      chat: FAKE_MARKED.supergroup,
      id: 5,
      title: "Example Topic",
      closed: false,
    })
  })

  test("is the chat's topic with its title", () => {
    expect(topicInputOf(new ForumTopic(fakeForumTopic(), peers))).toEqual({
      chat: FAKE_MARKED.supergroup,
      id: 5,
      title: "Example Topic",
      closed: false,
    })
  })

  test("is closed when the topic is, and has no title when it is missing", () => {
    const topic = fakeForumTopic({ closed: true, titleMissing: true, title: "" })
    expect(topicInputOf(new ForumTopic(topic, peers))).toEqual({
      chat: FAKE_MARKED.supergroup,
      id: 5,
      title: null,
      closed: true,
    })
  })
})

describe("topicInputOfAction", () => {
  const forum = fakeSupergroup({ forum: true })
  const inForum = { peerId: channelPeer() }

  function actionMessage(action: Parameters<typeof fakeServiceMessage>[0], overrides = {}) {
    return messageOf(fakeServiceMessage(action, { ...inForum, ...overrides }), forum, fakeUser())
  }

  test("needs no resolved peers for an edit's chat and topic ids", () => {
    const raw = fakeServiceMessage(
      { _: "messageActionTopicEdit", closed: false },
      { peerId: channelPeer(), replyTo: fakeTopicReplyHeader(5) },
    )
    expect(topicInputOfAction(messageOf(raw))).toEqual({ chat: FAKE_MARKED.supergroup, id: 5, closed: false })
  })

  test("is the new topic of a topic_created message, whose id is the message's", () => {
    const message = actionMessage({ _: "messageActionTopicCreate", title: "New Topic", iconColor: 1 }, { id: 12 })
    expect(topicInputOfAction(message)).toEqual({
      chat: FAKE_MARKED.supergroup,
      id: 12,
      title: "New Topic",
      closed: false,
    })
  })

  test("has no title when Telegram says it is missing", () => {
    const action = { _: "messageActionTopicCreate", title: "", iconColor: 1, titleMissing: true } as const
    expect(topicInputOfAction(actionMessage(action, { id: 12 }))).toMatchObject({ id: 12, title: null })
  })

  test("is the renamed topic of a topic_edited message, named by its reply", () => {
    const message = actionMessage(
      { _: "messageActionTopicEdit", title: "Renamed" },
      { id: 13, replyTo: fakeTopicReplyHeader(5) },
    )
    expect(topicInputOfAction(message)).toEqual({
      chat: FAKE_MARKED.supergroup,
      id: 5,
      title: "Renamed",
    })
  })

  test("is the closed topic of an edit that closes it, with no new title", () => {
    const message = actionMessage(
      { _: "messageActionTopicEdit", closed: true },
      { id: 13, replyTo: fakeReplyHeader({ replyToMsgId: 5 }) },
    )
    expect(topicInputOfAction(message)).toEqual({ chat: FAKE_MARKED.supergroup, id: 5, closed: true })
  })

  test("is null for an edit of the icon only, and for an edit that names no topic", () => {
    const iconOnly = actionMessage({ _: "messageActionTopicEdit" }, { replyTo: fakeTopicReplyHeader(5) })
    expect(topicInputOfAction(iconOnly)).toBeNull()
    expect(topicInputOfAction(actionMessage({ _: "messageActionTopicEdit", title: "Renamed" }))).toBeNull()
  })

  test("is null for any other action and for a text message", () => {
    expect(topicInputOfAction(actionMessage({ _: "messageActionPinMessage" }))).toBeNull()
    expect(topicInputOfAction(messageOf(fakeMessage(), fakeUser()))).toBeNull()
  })
})
