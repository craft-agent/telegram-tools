import type { tl } from "@mtcute/core"
import { channelPeer, fakeReactions, userPeer, type FakeReaction } from "./fake-telegram.testing"
import { storeMessage } from "./ingest-messages"
import type { ReactionInfo } from "./mirror-input"
import { messageInput, messageRow } from "./mirror.testing"
import type { ReactResult } from "./service-requests"
import { THEIRS, askWrite, seedActionChats, updatesGroup } from "./sync-action.testing"
import { FORUM, KEPT } from "./sync-requests.testing"
import { START_MS, type SyncFixture } from "./sync.testing"

/** Standard emoji the reaction tests use. */
export const THUMBS = "👍"
export const PARTY = "🎉"
export const FIRE = "🔥"

/** Messages of `KEPT` that someone else wrote: one with the user's own reaction among others, one with only the user's, one with only others', and `THEIRS`, with none. */
export const REACTED = { mine: 30, only: 31, others: 32, none: THEIRS }

/** A message of `FORUM` that someone else wrote, with a reaction of another. */
export const REACTED_IN_FORUM = 40

const REACTIONS: [string, number, ReactionInfo[]][] = [
  [
    KEPT,
    REACTED.mine,
    [
      { emoji: THUMBS, count: 2, mine: true },
      { emoji: PARTY, count: 1 },
    ],
  ],
  [KEPT, REACTED.only, [{ emoji: THUMBS, count: 1, mine: true }]],
  [KEPT, REACTED.others, [{ emoji: PARTY, count: 3 }]],
  [FORUM, REACTED_IN_FORUM, [{ emoji: THUMBS, count: 2 }]],
]

/** Lists the action tests' chats, with other people's messages that carry reactions. */
export function seedReactionChats(fixture: SyncFixture): void {
  seedActionChats(fixture)
  fixture.seed((mirror) => {
    for (const [chat, id, reactions] of REACTIONS) {
      storeMessage(mirror, { now: START_MS, keepDisappearing: false }, messageInput({ chat, id, reactions }))
    }
  })
}

/** Asks the running service to react with `params`. */
export function react(
  fixture: SyncFixture,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ReactResult> {
  return askWrite<ReactResult>(fixture, "react", params, signal)
}

/** The reactions the mirror stores for message `id` of `chat`: null when it has none. */
export function reactionsStored(fixture: SyncFixture, chat: string, id: number): ReactionInfo[] | null {
  const { reactions } = fixture.mirror((mirror) => messageRow(mirror, chat, id)) ?? {}
  return typeof reactions === "string" ? (JSON.parse(reactions) as ReactionInfo[]) : null
}

/** The answer to a reaction on message `id` of `KEPT`, or of `FORUM`: the updates group with the message's reactions as Telegram counts them. */
export function reactedAnswer(id: number, reactions: FakeReaction[], forum = false): tl.RawUpdates {
  return updatesGroup(
    [
      {
        _: "updateMessageReactions",
        peer: forum ? channelPeer() : userPeer(),
        msgId: id,
        reactions: fakeReactions(...reactions),
      },
    ],
    forum,
  )
}

/** An answer that names no reactions of the message: the updates group holds nothing about it. */
export function silentAnswer(): tl.RawUpdates {
  return updatesGroup([])
}
