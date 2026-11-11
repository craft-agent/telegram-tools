import { ReactionCount, type tl } from "@mtcute/core"
import { ACTION_PAST, ownReaction, storedReactions } from "./action-checks"
import { markedId, reactionInfosOf } from "./from-mtcute-parts"
import { inTransaction } from "./mirror"
import type { ReactionInfo } from "./mirror-input"
import { toJson } from "./mirror-rows"
import type { ReactParams, ReactResult } from "./service-requests"
import type { ServiceCall } from "./service-server"
import { performAction, recordAction, resolveChatPeer, runAction, updatesOf, type ActionContext } from "./sync-action"
import { anyMessageOf, storedMessageOf } from "./sync-action-mirror"
import { MESSAGE_GONE, type ActionRefusals, type ActionWords } from "./sync-action-outcome"
import { writing } from "./sync-ending"
import { parseReactParams } from "./sync-request-params"
import type { RequestQueue } from "./sync-request-queue"
import { handOver } from "./sync-send"
import { FORBIDDEN_ERRORS } from "./sync-send-outcome"

const REACT_WORDS: ActionWords = {
  name: "reaction",
  gerund: "changing",
  past: ACTION_PAST.react,
  untouched: "the reaction is unchanged",
}

/**
 * How a failed reaction is told. `MESSAGE_NOT_MODIFIED` is the user's reaction
 * already being what was asked: the pre-check ruled out asking for what the
 * mirror shows, so it means an earlier delivery of this call landed, or that
 * the mirror was behind.
 */
const REACT_REFUSALS: ActionRefusals = {
  words: REACT_WORDS,
  already: ["MESSAGE_NOT_MODIFIED"],
  named: [
    MESSAGE_GONE,
    {
      names: ["REACTION_INVALID", "REACTION_EMPTY"],
      code: "invalid_argument",
      what: "Telegram does not take this reaction here",
    },
    { names: ["REACTIONS_TOO_MANY"], code: "forbidden", what: "Telegram allows no more reactions on this message" },
    { names: ["PREMIUM_ACCOUNT_REQUIRED"], code: "forbidden", what: "Telegram wants Premium for this reaction" },
    // Before the groups every action shares, whose sentence names the action as a verb.
    { names: FORBIDDEN_ERRORS, code: "forbidden", what: "Telegram does not let this account react here" },
  ],
}

/** The reactions of the message after the call, when the answer carries them as Telegram counts them; undefined when it does not. */
function toldReactions(response: tl.TypeUpdates, chat: string, id: number): ReactionInfo[] | undefined {
  for (const update of updatesOf(response)) {
    if (update._ !== "updateMessageReactions" || update.msgId !== id || markedId(update.peer) !== chat) continue
    // The counts of a min object say nothing of the user's own reaction.
    if (update.reactions.min) continue
    return reactionInfosOf(update.reactions.results.map((count) => new ReactionCount(count)))
  }
  return undefined
}

/**
 * `reactions` with the user's own taken out (one fewer for its emoji, none
 * left when it was the only one) and, when `emoji` is given, theirs put in
 * (one more for it, marked as theirs).
 */
function withOwnReaction(reactions: readonly ReactionInfo[], emoji: string | undefined): ReactionInfo[] {
  const others = reactions.flatMap((reaction): ReactionInfo[] => {
    if (!reaction.mine) return [reaction]
    return reaction.count > 1 ? [{ emoji: reaction.emoji, count: reaction.count - 1 }] : []
  })
  if (emoji === undefined) return others
  const own: ReactionInfo = {
    emoji,
    count: (others.find((reaction) => reaction.emoji === emoji)?.count ?? 0) + 1,
    mine: true,
  }
  return others.some((reaction) => reaction.emoji === emoji)
    ? others.map((reaction) => (reaction.emoji === emoji ? own : reaction))
    : [...others, own]
}

/**
 * Records the message's reactions in the mirror in one transaction: Telegram's
 * own counts when the answer carries them, else the ones the mirror has with
 * the user's reaction replaced or removed.
 */
function recordReaction(ctx: ActionContext, { chat, id, emoji }: ReactParams, response: tl.TypeUpdates): void {
  recordAction(ctx, "react", () => {
    const reactions =
      toldReactions(response, chat, id) ??
      withOwnReaction(storedReactions(storedMessageOf(ctx.mirror, chat, id)?.reactions ?? null), emoji)
    writing(() =>
      inTransaction(ctx.mirror, () =>
        ctx.mirror
          .prepare("UPDATE messages SET reactions = ? WHERE chat = ? AND id = ?")
          .run(toJson(reactions), chat, id),
      ),
    )
  })
}

/** What the message has from the user once the reaction is as asked. */
function doneOf({ id, emoji }: ReactParams): ReactResult {
  return emoji === undefined ? { id, removed: true } : { id, emoji }
}

/** Checks the reaction against the mirror, then asks for it once. See `reactRequest`. */
async function reactTo(
  ctx: ActionContext,
  call: ServiceCall,
  signal: AbortSignal,
  params: ReactParams,
): Promise<ReactResult> {
  const { message } = anyMessageOf(ctx.mirror, params.chat, params.id, REACT_WORDS)
  // Only the emoji shown as the user's own is skipped: a mirror without one may be behind, since reactions of the chat's other people are not followed live.
  if (params.emoji !== undefined && ownReaction(storedReactions(message.reactions)) === params.emoji) {
    return { ...doneOf(params), already: true }
  }
  const peer = await resolveChatPeer(ctx, call, signal, "react", params.chat)

  // This replaces all the user's reactions on the message; none removes them.
  const request: tl.messages.RawSendReactionRequest = {
    _: "messages.sendReaction",
    peer,
    msgId: params.id,
    reaction: params.emoji === undefined ? [] : [{ _: "reactionEmoji", emoticon: params.emoji }],
  }
  const response = await performAction(ctx, signal, REACT_REFUSALS, request)
  if (response === undefined) return { ...doneOf(params), already: true }
  handOver(ctx, response, "react")
  recordReaction(ctx, params, response)
  return doneOf(params)
}

/**
 * Answers a `react` request: the user's reaction on a message of any author,
 * in a chat the mirror lists, set to one emoji (replacing the one they had) or
 * removed, through one low-level call, and recorded in the mirror. Checked
 * against the mirror first, and failing as `forbidden` or `not_found` with
 * nothing changed (see `targetOf`). An emoji the mirror shows as the user's
 * own is done without a call. The outcome is never guessed: see
 * `actionFailureOf`. Reactions run one at a time through `queue`, which the
 * sends share.
 */
export function reactRequest(
  ctx: ActionContext,
  queue: RequestQueue,
  raw: unknown,
  call: ServiceCall,
): Promise<ReactResult> {
  return runAction(ctx, queue, raw, call, parseReactParams, (params, signal) => reactTo(ctx, call, signal, params))
}
