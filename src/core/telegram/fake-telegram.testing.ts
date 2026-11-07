import { Long, Message, PeersIndex, getMarkedPeerId } from "@mtcute/core"
import type { tl } from "@mtcute/core"
import { Buffer } from "node:buffer"

/** A TL object without its constructor name, with fields to override. */
export type Overrides<T extends { _: string }> = Partial<Omit<T, "_">>

/** Made-up bare ids, as Telegram sends them in raw objects. */
export const FAKE_IDS = {
  me: 7_000_000_001,
  alice: 7_000_000_002,
  bot: 7_000_000_003,
  group: 7_100_000_001,
  supergroup: 7_200_000_001,
  channel: 7_200_000_002,
} as const

/** The same chats as the marked ids a mirror would hold, written out by hand. */
export const FAKE_MARKED = {
  me: "7000000001",
  alice: "7000000002",
  bot: "7000000003",
  group: "-7100000001",
  supergroup: "-1007200000001",
  channel: "-1007200000002",
} as const

/** A fixed moment in Unix seconds, as raw objects carry times; the same in milliseconds is `FAKE_DATE * 1000`. */
export const FAKE_DATE = 1_790_000_000

/** `ttlSeconds` of view-once media, written out here rather than imported from the code under test. */
export const FAKE_VIEW_ONCE_TTL = 0x7fffffff

/** A made-up phone number: it must never reach a mirror input. */
export const FAKE_PHONE = "+15550100123"

export const FAKE_VCARD = "PRIVATE-VCARD-EXAMPLE"
export const FAKE_PHOTO_ID = Long.fromString("580000000001")
export const FAKE_DOCUMENT_ID = Long.fromString("580000000002")
export const FAKE_DC_ID = 193

/** A made-up access hash, on every peer and file. */
export const FAKE_ACCESS_HASH = Long.fromString("4611686018427387905")

/** Made-up file reference bytes, on every photo and document. */
export const FAKE_FILE_REFERENCE = Uint8Array.of(0xde, 0xad, 0xbe, 0xef, 0x12, 0x34)

/** A made-up place: it must never reach a mirror input. */
export const FAKE_GEO = { lat: 12.3456789, long: 98.7654321 } as const

/** Texts that must appear nowhere in what is made of fake objects: the phone, the access hash and the place. */
export const FAKE_PRIVATE_VALUES: readonly string[] = [
  FAKE_PHONE,
  FAKE_PHONE.slice(1),
  FAKE_ACCESS_HASH.toString(),
  JSON.stringify(FAKE_ACCESS_HASH),
  String(FAKE_GEO.lat),
  String(FAKE_GEO.long),
  FAKE_VCARD,
  FAKE_PHOTO_ID.toString(),
  JSON.stringify(FAKE_PHOTO_ID),
  FAKE_DOCUMENT_ID.toString(),
  JSON.stringify(FAKE_DOCUMENT_ID),
  String(FAKE_DC_ID),
  Array.from(FAKE_FILE_REFERENCE).join(","),
  JSON.stringify(FAKE_FILE_REFERENCE),
  Buffer.from(FAKE_FILE_REFERENCE).toString("hex"),
  Buffer.from(FAKE_FILE_REFERENCE).toString("base64"),
]

const NO_PHOTO: tl.RawChatPhotoEmpty = { _: "chatPhotoEmpty" }

/** A peer reference to a user. */
export function userPeer(id: number = FAKE_IDS.alice): tl.RawPeerUser {
  return { _: "peerUser", userId: id }
}

/** A peer reference to a basic group. */
export function chatPeer(id: number = FAKE_IDS.group): tl.RawPeerChat {
  return { _: "peerChat", chatId: id }
}

/** A peer reference to a supergroup or channel. */
export function channelPeer(id: number = FAKE_IDS.supergroup): tl.RawPeerChannel {
  return { _: "peerChannel", channelId: id }
}

/** A person, with fields to override. */
export function fakeUser(overrides: Overrides<tl.RawUser> = {}): tl.RawUser {
  return {
    _: "user",
    id: FAKE_IDS.alice,
    accessHash: FAKE_ACCESS_HASH,
    self: false,
    bot: false,
    firstName: "Alice",
    lastName: "Example",
    username: "alice_example",
    phone: FAKE_PHONE,
    ...overrides,
  }
}

/** The logged-in account itself. */
export function fakeSelf(overrides: Overrides<tl.RawUser> = {}): tl.RawUser {
  return fakeUser({ id: FAKE_IDS.me, self: true, firstName: "Me", username: "me_example", ...overrides })
}

/** A bot. */
export function fakeBot(overrides: Overrides<tl.RawUser> = {}): tl.RawUser {
  return fakeUser({
    id: FAKE_IDS.bot,
    bot: true,
    firstName: "Example Bot",
    lastName: undefined,
    username: "example_bot",
    ...overrides,
  })
}

/** A basic group. */
export function fakeBasicGroup(overrides: Overrides<tl.RawChat> = {}): tl.RawChat {
  return {
    _: "chat",
    id: FAKE_IDS.group,
    title: "Example Group",
    photo: NO_PHOTO,
    participantsCount: 3,
    date: FAKE_DATE,
    version: 1,
    ...overrides,
  }
}

/** A supergroup; pass `forum: true` for one with topics. */
export function fakeSupergroup(overrides: Overrides<tl.RawChannel> = {}): tl.RawChannel {
  return {
    _: "channel",
    megagroup: true,
    id: FAKE_IDS.supergroup,
    accessHash: FAKE_ACCESS_HASH,
    title: "Example Supergroup",
    photo: NO_PHOTO,
    date: FAKE_DATE,
    ...overrides,
  }
}

/** A broadcast channel. */
export function fakeChannel(overrides: Overrides<tl.RawChannel> = {}): tl.RawChannel {
  return fakeSupergroup({
    megagroup: false,
    broadcast: true,
    id: FAKE_IDS.channel,
    title: "Example Channel",
    ...overrides,
  })
}

/** A basic group the account can no longer reach. */
export function fakeForbiddenGroup(overrides: Overrides<tl.RawChatForbidden> = {}): tl.RawChatForbidden {
  return { _: "chatForbidden", id: FAKE_IDS.group, title: "Example Group", ...overrides }
}

/** A channel the account can no longer reach. */
export function fakeForbiddenChannel(overrides: Overrides<tl.RawChannelForbidden> = {}): tl.RawChannelForbidden {
  return {
    _: "channelForbidden",
    broadcast: true,
    id: FAKE_IDS.channel,
    accessHash: FAKE_ACCESS_HASH,
    title: "Example Channel",
    ...overrides,
  }
}

/** A community, a collection of linked chats. */
export function fakeCommunity(overrides: Overrides<tl.RawCommunity> = {}): tl.RawCommunity {
  return {
    _: "community",
    id: FAKE_IDS.channel,
    title: "Example Community",
    photo: NO_PHOTO,
    date: FAKE_DATE,
    ...overrides,
  }
}

/** The index of the peers a test's objects refer to. */
export function peersOf(...peers: (tl.TypeUser | tl.TypeChat)[]): PeersIndex {
  const isUser = (peer: tl.TypeUser | tl.TypeChat): peer is tl.TypeUser => peer._ === "user" || peer._ === "userEmpty"
  return PeersIndex.from({
    users: peers.filter(isUser),
    chats: peers.filter((peer): peer is tl.TypeChat => !isUser(peer)),
  })
}

/** The mtcute message a raw one becomes, with the peers it refers to. */
export function messageOf(raw: tl.TypeMessage, ...peers: (tl.TypeUser | tl.TypeChat)[]): Message {
  return new Message(raw, peersOf(...peers))
}

/** A text message from Alice in her private chat, with fields to override. */
export function fakeMessage(overrides: Overrides<tl.RawMessage> = {}): tl.RawMessage {
  return {
    _: "message",
    id: 1,
    out: false,
    peerId: userPeer(),
    fromId: userPeer(),
    date: FAKE_DATE,
    message: "hello",
    ...overrides,
  }
}

/** A service message in Alice's private chat, with fields to override. */
export function fakeServiceMessage(
  action: tl.TypeMessageAction,
  overrides: Overrides<tl.RawMessageService> = {},
): tl.RawMessageService {
  return {
    _: "messageService",
    id: 1,
    out: false,
    peerId: userPeer(),
    fromId: userPeer(),
    date: FAKE_DATE,
    action,
    ...overrides,
  }
}

/** Text entity: a link whose text hides its address. */
export function fakeTextLink(offset: number, length: number, url: string): tl.RawMessageEntityTextUrl {
  return { _: "messageEntityTextUrl", offset, length, url }
}

/** Text entity: a mention of a user by name. */
export function fakeMentionName(offset: number, length: number, userId: number): tl.RawMessageEntityMentionName {
  return { _: "messageEntityMentionName", offset, length, userId }
}

/** Text entity: bold text. */
export function fakeBold(offset: number, length: number): tl.RawMessageEntityBold {
  return { _: "messageEntityBold", offset, length }
}

/** One reaction on a message: an emoji, or a custom emoji by its id; `chosen` is the order of the account's own. */
export type FakeReaction = { emoji: string | tl.Long; count: number; chosen?: number }

/** The reactions of a message. */
export function fakeReactions(...reactions: FakeReaction[]): tl.RawMessageReactions {
  return {
    _: "messageReactions",
    results: reactions.map(({ emoji, count, chosen }) => ({
      _: "reactionCount",
      count,
      chosenOrder: chosen,
      reaction:
        typeof emoji === "string"
          ? { _: "reactionEmoji", emoticon: emoji }
          : { _: "reactionCustomEmoji", documentId: emoji },
    })),
  }
}

/** The header of a forwarded message: from Alice, 10 minutes before `FAKE_DATE`; pass `fromName` for a hidden sender. */
export function fakeForwardHeader(overrides: Overrides<tl.RawMessageFwdHeader> = {}): tl.RawMessageFwdHeader {
  return { _: "messageFwdHeader", date: FAKE_DATE - 600, fromId: userPeer(), ...overrides }
}

/** The header of a reply to message 1 of the same chat. */
export function fakeReplyHeader(overrides: Overrides<tl.RawMessageReplyHeader> = {}): tl.RawMessageReplyHeader {
  return { _: "messageReplyHeader", replyToMsgId: 1, ...overrides }
}

/**
 * The header of a message in forum topic `topic`: a plain post names the topic
 * as the message it replies to, and a reply names the replied-to message and
 * the topic apart.
 */
export function fakeTopicReplyHeader(topic: number, repliesTo?: number): tl.RawMessageReplyHeader {
  return repliesTo === undefined
    ? fakeReplyHeader({ forumTopic: true, replyToMsgId: topic })
    : fakeReplyHeader({ forumTopic: true, replyToMsgId: repliesTo, replyToTopId: topic })
}

/** The update for messages deleted for everyone: in a supergroup or channel when `channelId` is given. */
export function fakeDeleteUpdate(
  ids: number[],
  channelId?: number,
): tl.RawUpdateDeleteMessages | tl.RawUpdateDeleteChannelMessages {
  return channelId === undefined
    ? { _: "updateDeleteMessages", messages: ids, pts: 1, ptsCount: ids.length }
    : { _: "updateDeleteChannelMessages", channelId, messages: ids, pts: 1, ptsCount: ids.length }
}

/** Alice's chat read on another device up to message 10, with 2 left unread. */
export function fakeReadUpdate(overrides: Overrides<tl.RawUpdateReadHistoryInbox> = {}): tl.RawUpdateReadHistoryInbox {
  return {
    _: "updateReadHistoryInbox",
    peer: userPeer(),
    maxId: 10,
    stillUnreadCount: 2,
    pts: 1,
    ptsCount: 1,
    ...overrides,
  }
}

/** Alice read the account's messages in her chat up to message 10. */
export function fakeOutboxReadUpdate(): tl.RawUpdateReadHistoryOutbox {
  return { _: "updateReadHistoryOutbox", peer: userPeer(), maxId: 10, pts: 1, ptsCount: 1 }
}

/** The supergroup read up to message 10, with 2 left unread. */
export function fakeChannelReadUpdate(
  overrides: Overrides<tl.RawUpdateReadChannelInbox> = {},
): tl.RawUpdateReadChannelInbox {
  return {
    _: "updateReadChannelInbox",
    channelId: FAKE_IDS.supergroup,
    maxId: 10,
    stillUnreadCount: 2,
    pts: 1,
    ...overrides,
  }
}

/** A thread of the supergroup, topped by message 5, read up to message 10. */
export function fakeThreadReadUpdate(): tl.RawUpdateReadChannelDiscussionInbox {
  return { _: "updateReadChannelDiscussionInbox", channelId: FAKE_IDS.supergroup, topMsgId: 5, readMaxId: 10 }
}

/** A dialog with Alice by default: 2 unread, read up to message 8, newest message 9. */
export function fakeDialog(peer: tl.TypePeer = userPeer(), overrides: Overrides<tl.RawDialog> = {}): tl.RawDialog {
  return {
    _: "dialog",
    peer,
    topMessage: 9,
    readInboxMaxId: 8,
    readOutboxMaxId: 0,
    unreadCount: 2,
    unreadMentionsCount: 0,
    unreadReactionsCount: 0,
    unreadPollVotesCount: 0,
    notifySettings: { _: "peerNotifySettings" },
    ...overrides,
  }
}

/** The newest messages a dialog list brings along, by their chats' marked ids. */
export function dialogMessages(...messages: tl.RawMessage[]): Map<number, tl.TypeMessage> {
  return new Map(messages.map((message) => [getMarkedPeerId(message.peerId), message]))
}

/** A topic of the fake supergroup, made by Alice. */
export function fakeForumTopic(overrides: Overrides<tl.RawForumTopic> = {}): tl.RawForumTopic {
  return {
    _: "forumTopic",
    id: 5,
    date: FAKE_DATE,
    peer: channelPeer(),
    title: "Example Topic",
    iconColor: 0x6fb9f0,
    topMessage: 9,
    readInboxMaxId: 0,
    readOutboxMaxId: 0,
    unreadCount: 0,
    unreadMentionsCount: 0,
    unreadReactionsCount: 0,
    unreadPollVotesCount: 0,
    fromId: userPeer(),
    notifySettings: { _: "peerNotifySettings" },
    ...overrides,
  }
}
