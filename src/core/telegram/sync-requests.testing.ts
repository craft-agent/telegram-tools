import { ForumTopic, type Message } from "@mtcute/core"
import {
  FAKE_DATE,
  FAKE_MARKED,
  channelPeer,
  fakeForumTopic,
  fakeMessage,
  fakeSupergroup,
  fakeUser,
  messageOf,
  peersOf,
  userPeer,
} from "./fake-telegram.testing"
import { setFollowed, upsertChats } from "./ingest-chats"
import { storeMessage } from "./ingest-messages"
import type { ChatInput } from "./mirror-input"
import { SUPERGROUP, chatInput, messageInput } from "./mirror.testing"
import { callService } from "./service"
import { START_MS, type SyncFixture } from "./sync.testing"

/** A forum supergroup the mirror lists and does not keep. */
export const FORUM = FAKE_MARKED.supergroup

/** A supergroup without topics, listed and not kept. */
export const PLAIN = SUPERGROUP

/** A private chat the mirror keeps. */
export const KEPT = FAKE_MARKED.alice

/** A chat the mirror does not list at all. */
export const UNLISTED = "-1009999999999"

const listed: ChatInput[] = [
  chatInput({ id: KEPT }),
  chatInput({ id: FORUM, kind: "supergroup", name: "Forum", username: null, forum: true }),
  chatInput({ id: PLAIN, kind: "supergroup", name: "Plain", username: null }),
]

/** Lists a kept private chat, a forum supergroup and a plain supergroup, the way an earlier run left them. */
export function seedListedChats(fixture: SyncFixture): void {
  fixture.seed((mirror) => {
    upsertChats(mirror, listed, START_MS)
    setFollowed(mirror, KEPT, true)
  })
}

/** Calls a request of the running service on its socket. */
export function request<T = unknown>(
  fixture: SyncFixture,
  method: string,
  params?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  return callService<T>(fixture.paths.socket, method, params, { effect: "read", signal })
}

/** A message in the forum supergroup, sent `secondsAfter` seconds after the fake moment. */
export function groupMessage(id: number, secondsAfter = id): Message {
  const date = FAKE_DATE + secondsAfter
  return messageOf(fakeMessage({ id, peerId: channelPeer(), fromId: userPeer(), date }), fakeUser(), fakeSupergroup())
}

const SECOND_MS = 1000

/** The Unix milliseconds `groupMessage` stamps its message with. */
export function sentAtMs(secondsAfter: number): number {
  return (FAKE_DATE + secondsAfter) * SECOND_MS
}

/** A message from Alice in the kept private chat, as Telegram brings it; sent `secondsAfter` seconds after the fake moment. */
export function keptMessage(id: number, secondsAfter = id): Message {
  return messageOf(fakeMessage({ id, date: FAKE_DATE + secondsAfter }), fakeUser())
}

/** Stores messages `from` to `to` of the kept chat, as `keptMessage` stamps them, the way an earlier run left them. */
export function seedKeptMessages(fixture: SyncFixture, from: number, to: number): void {
  fixture.seed((mirror) => {
    for (let id = from; id <= to; id++) {
      storeMessage(
        mirror,
        { now: START_MS, keepDisappearing: false },
        messageInput({ chat: KEPT, id, ts: sentAtMs(id) }),
      )
    }
  })
}

/** A topic of the forum supergroup whose newest message is `topMessage` (included only when `withMessage`). */
export function forumTopic(
  id: number,
  overrides: Parameters<typeof fakeForumTopic>[0] = {},
  withMessage = true,
): ForumTopic {
  const raw = fakeForumTopic({ id, title: `Topic ${id}`, topMessage: 100 + id, ...overrides })
  const newest = fakeMessage({ id: raw.topMessage, peerId: channelPeer(), fromId: userPeer(), date: FAKE_DATE + id })
  return new ForumTopic(
    raw,
    peersOf(fakeUser(), fakeSupergroup()),
    withMessage ? new Map([[raw.topMessage, newest]]) : undefined,
  )
}
