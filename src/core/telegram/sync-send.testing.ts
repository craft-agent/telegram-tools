import type { tl } from "@mtcute/core"
import {
  FAKE_DATE,
  FAKE_IDS,
  channelPeer,
  fakeMessage,
  fakeReplyHeader,
  fakeSelf,
  fakeSupergroup,
  fakeTopicReplyHeader,
  fakeUser,
  userPeer,
} from "./fake-telegram.testing"
import { setFollowed, upsertChats, upsertTopics } from "./ingest-chats"
import { storeMessage } from "./ingest-messages"
import { CHANNEL, GROUP, OTHER_USER, chatInput, messageInput } from "./mirror.testing"
import { callService } from "./service"
import type { SendResult } from "./service-requests"
import type { FakeSend } from "./sync-client-send.testing"
import { FORUM, KEPT, seedKeptMessages, seedListedChats } from "./sync-requests.testing"
import { START_MS, type SyncFixture } from "./sync.testing"

/** The text the send tests send unless they say otherwise. */
export const TEXT = "Hello from the tests"

/** A topic of the forum supergroup the mirror keeps open, and one it keeps closed. */
export const OPEN_TOPIC = 5
export const CLOSED_TOPIC = 7

/** The Unix second Telegram stamps the sent message with. */
export const SENT_DATE = FAKE_DATE + 100

/** The same moment in milliseconds, as a result gives it. */
export const SENT_MS = SENT_DATE * 1000

/** A basic group the account left, and a private chat the account is known not to be able to write in. */
export const LEFT_GROUP = GROUP
export const MUTED_CHAT = OTHER_USER

/** The ids of the messages of `KEPT` the mirror holds, which a reply may name. */
export const STORED_IDS = [1, 2, 3]

/** What seeding the chats of a send test adds to the listed chats. */
export type SendSeed = {
  /** Keep the forum supergroup on the sync list, so that the mirror holds its messages. */
  mirrorForum?: boolean
}

/**
 * Lists the chats the send tests use: a kept private chat holding messages
 * 1 to 3, a forum supergroup with an open and a closed topic, a plain
 * supergroup, a group the account left, a chat it cannot write in and a channel.
 */
export function seedSendChats(fixture: SyncFixture, { mirrorForum = false }: SendSeed = {}): void {
  seedListedChats(fixture)
  seedKeptMessages(fixture, 1, STORED_IDS.length)
  fixture.seed((mirror) => {
    upsertChats(
      mirror,
      [
        chatInput({ id: LEFT_GROUP, kind: "group", name: "Left", username: null, left: true }),
        chatInput({ id: MUTED_CHAT, name: "Muted", username: null, canSend: false }),
        chatInput({ id: CHANNEL, kind: "channel", name: "News", username: null }),
      ],
      START_MS,
    )
    setFollowed(mirror, LEFT_GROUP, true)
    upsertTopics(
      mirror,
      [
        { chat: FORUM, id: OPEN_TOPIC, title: "Open", closed: false },
        { chat: FORUM, id: CLOSED_TOPIC, title: "Closed", closed: true },
      ],
      START_MS,
    )
    if (!mirrorForum) return
    mirror.prepare("INSERT INTO sync_list (chat, added, seeded) VALUES (?, ?, ?)").run(FORUM, START_MS, START_MS)
    setFollowed(mirror, FORUM, true)
  })
}

/** Stores a message the user sent in `KEPT` with `text`, `agoMs` before the fake clock. */
export function seedOwnMessage(fixture: SyncFixture, id: number, text: string, agoMs = 10_000): void {
  fixture.seed((mirror) => {
    const message = messageInput({ chat: KEPT, id, fromMe: true, sender: null, body: text, ts: START_MS - agoMs })
    storeMessage(mirror, { now: START_MS, keepDisappearing: false }, message)
  })
}

/** Asks the running service to send `params`. */
export function send(fixture: SyncFixture, params: Record<string, unknown>, signal?: AbortSignal): Promise<SendResult> {
  return callService<SendResult>(fixture.paths.socket, "send", params, { effect: "write", signal })
}

/** Every call the service made to send, with the options it made it with. */
export function sendsOf(fixture: SyncFixture): FakeSend[] {
  return fixture.client.argsOf("call") as FakeSend[]
}

/** The answer Telegram gives a send to a private chat or a basic group: the id and the time only. */
export function shortSent(
  id: number,
  overrides: Partial<tl.RawUpdateShortSentMessage> = {},
): tl.RawUpdateShortSentMessage {
  return { _: "updateShortSentMessage", out: true, id, pts: 40, ptsCount: 1, date: SENT_DATE, ...overrides }
}

/** Makes every later call answer with the short form for message `id`. */
export function answerShort(fixture: SyncFixture, id: number): void {
  fixture.client.setCallAnswer(shortSent(id))
}

/** The `updateMessageID` that names the message of the request, as Telegram sends it first. */
function idUpdate({ request }: FakeSend, id: number): tl.RawUpdateMessageID {
  return { _: "updateMessageID", id, randomId: request.randomId }
}

/** The answer for a send to `KEPT` that is an updates group: the id, then the message itself. */
export function privateUpdates(send: FakeSend, id: number, replyTo?: number): tl.RawUpdates {
  const { request } = send
  const message = fakeMessage({
    id,
    out: true,
    fromId: undefined,
    message: request.message,
    date: SENT_DATE,
    ...(replyTo === undefined ? {} : { replyTo: fakeReplyHeader({ replyToMsgId: replyTo }) }),
  })
  return {
    _: "updates",
    updates: [idUpdate(send, id), { _: "updateNewMessage", message, pts: 40, ptsCount: 1 }],
    users: [fakeUser(), fakeSelf()],
    chats: [],
    date: SENT_DATE,
    seq: 0,
  }
}

/** The answer for a send to the forum supergroup: the id, then the message in `topic`, replying to `replyTo` if given. */
export function forumUpdates(send: FakeSend, id: number, topic?: number, replyTo?: number): tl.RawUpdates {
  const { request } = send
  const message = fakeMessage({
    id,
    out: true,
    peerId: channelPeer(),
    fromId: userPeer(FAKE_IDS.me),
    message: request.message,
    date: SENT_DATE,
    ...(topic === undefined ? {} : { replyTo: fakeTopicReplyHeader(topic, replyTo) }),
  })
  return {
    _: "updates",
    updates: [idUpdate(send, id), { _: "updateNewChannelMessage", message, pts: 41, ptsCount: 1 }],
    users: [fakeUser(), fakeSelf()],
    chats: [fakeSupergroup({ forum: true })],
    date: SENT_DATE,
    seq: 0,
  }
}
