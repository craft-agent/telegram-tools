import type { tl } from "@mtcute/core"
import {
  FAKE_DATE,
  FAKE_IDS,
  FAKE_MARKED,
  channelPeer,
  fakeReplyHeader,
  fakeServiceMessage,
  userPeer,
} from "./fake-telegram.testing"
import { setFollowed, upsertChats } from "./ingest-chats"
import { storeMessage } from "./ingest-messages"
import { chatInput, messageInput } from "./mirror.testing"
import type { PinResult } from "./service-requests"
import { askWrite, seedActionChats, updatesGroup } from "./sync-action.testing"
import { START_MS, type SyncFixture } from "./sync.testing"

/** A chat with a bot and Saved Messages, which the pin tests keep besides the action tests' chats. */
export const BOT_CHAT = FAKE_MARKED.bot
export const SAVED = FAKE_MARKED.me

/** The id of the service message a pin makes, and its time in Unix seconds. */
export const PIN_SERVICE_ID = 90
export const PIN_DATE = FAKE_DATE + 300

/** The message of `BOT_CHAT` and of `SAVED` the pin tests pin. */
export const IN_OTHER_CHAT = 1

/** Lists the action tests' chats and a kept chat with a bot and Saved Messages, each holding message `IN_OTHER_CHAT`. */
export function seedPinChats(fixture: SyncFixture): void {
  seedActionChats(fixture)
  fixture.seed((mirror) => {
    const chats = [
      chatInput({ id: BOT_CHAT, kind: "bot", name: "Example Bot", username: "example_bot" }),
      chatInput({ id: SAVED, kind: "self", name: "Saved Messages", username: null }),
    ]
    upsertChats(mirror, chats, START_MS)
    for (const { id } of chats) {
      setFollowed(mirror, id, true)
      storeMessage(
        mirror,
        { now: START_MS, keepDisappearing: false },
        messageInput({ chat: id, id: IN_OTHER_CHAT, ts: START_MS - 60_000 }),
      )
    }
  })
}

/** Asks the running service to pin or unpin with `params`. */
export function pin(fixture: SyncFixture, params: Record<string, unknown>, signal?: AbortSignal): Promise<PinResult> {
  return askWrite<PinResult>(fixture, "pin", params, signal)
}

/** The service message "pinned a message" the user's pin of message `id` makes, in `KEPT` or, with `forum`, in `FORUM`. */
function pinService(id: number, forum: boolean): tl.RawMessageService {
  return fakeServiceMessage(
    { _: "messageActionPinMessage" },
    {
      id: PIN_SERVICE_ID,
      out: true,
      date: PIN_DATE,
      replyTo: fakeReplyHeader({ replyToMsgId: id }),
      ...(forum ? { peerId: channelPeer(), fromId: userPeer(FAKE_IDS.me) } : { fromId: undefined }),
    },
  )
}

/**
 * The answer to a pin of message `id` of `KEPT`, or of `FORUM` with `forum`:
 * the pin, and with `service` the service message that tells the members.
 */
export function pinnedAnswer(id: number, { forum = false, service = false } = {}): tl.RawUpdates {
  const pinned: tl.TypeUpdate = forum
    ? {
        _: "updatePinnedChannelMessages",
        pinned: true,
        channelId: FAKE_IDS.supergroup,
        messages: [id],
        pts: 70,
        ptsCount: 1,
      }
    : { _: "updatePinnedMessages", pinned: true, peer: userPeer(), messages: [id], pts: 70, ptsCount: 1 }
  const message = pinService(id, forum)
  const told: tl.TypeUpdate[] = forum
    ? [{ _: "updateNewChannelMessage", message, pts: 71, ptsCount: 1 }]
    : [{ _: "updateNewMessage", message, pts: 71, ptsCount: 1 }]
  return updatesGroup(service ? [pinned, ...told] : [pinned], forum)
}
