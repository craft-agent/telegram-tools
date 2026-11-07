import { isChatId, isCount, type DeleteInput, type IngestContext } from "./mirror-input"
import type { Mirror } from "./mirror"
import { PER_CHAT_KINDS_SQL, recordDeleted } from "./mirror-rows"

/** A delete this close to a message's auto-delete time is taken as the timer's own, not a delete for everyone: 5 minutes. */
export const DELETE_GRACE_MS = 5 * 60 * 1000

/** After a gap in watching, how long the catch-up of what it held may take: 10 minutes. */
export const GAP_SETTLE_MS = 10 * 60 * 1000

/** How long a delete fences out a history fetch that started before it: 2 days. */
export const TOMBSTONE_TTL_MS = 2 * 24 * 60 * 60 * 1000

/** How long a gap in watching is remembered: 30 days. */
export const GAP_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** What a delete did to one message id: removed it, kept it past its timer, or found none and only recorded the delete. */
export type DeleteOutcome = "removed" | "kept" | "tombstoned"

type Gap = { start: number; until: number }

type Target = { chat: string; expires: number | null }

function loadGaps(mirror: Mirror): Gap[] {
  return mirror.prepare("SELECT start, until FROM gaps").all() as Gap[]
}

/** The stored messages a delete of `id` means: the named chat's, else those of every chat whose ids are account-wide. */
function targetsOf(mirror: Mirror, chat: string | null, id: number): Target[] {
  if (chat !== null) {
    return mirror.prepare("SELECT chat, expires FROM messages WHERE id = ? AND chat = ?").all(id, chat) as Target[]
  }
  return mirror
    .prepare(
      `SELECT m.chat, m.expires FROM messages m JOIN chats c ON c.id = m.chat
       WHERE m.id = ? AND c.kind NOT IN (${PER_CHAT_KINDS_SQL})`,
    )
    .all(id) as Target[]
}

/**
 * Whether a delete of a message with this timer is the timer running out, not
 * a delete for everyone. Clients expire such messages by their own timer, and
 * a delete carries no time, so it counts as the expiry only when it arrives
 * within `DELETE_GRACE_MS` of the timer and the timer did not run out inside a
 * gap in watching (each gap extended by `GAP_SETTLE_MS`), where a delete made
 * earlier could have been held back until then. Anything else is a delete for
 * everyone, which outranks keeping.
 */
function isExpiry(expires: number | null, now: number, gaps: Gap[]): boolean {
  if (expires === null || Math.abs(now - expires) > DELETE_GRACE_MS) return false
  const edge = expires - DELETE_GRACE_MS
  return !gaps.some((gap) => gap.start < edge && edge < gap.until + GAP_SETTLE_MS)
}

function removeMessage(mirror: Mirror, chat: string, id: number): void {
  mirror.prepare("DELETE FROM edits WHERE chat = ? AND id = ?").run(chat, id)
  mirror.prepare("DELETE FROM messages WHERE chat = ? AND id = ?").run(chat, id)
}

/**
 * Messages deleted for everyone, with the outcome for each valid id (an id
 * that is not a positive integer is skipped, and a delete naming an empty chat
 * is skipped whole).
 *
 * Without a chat, the target is every message of that id in a chat whose ids
 * are account-wide (private chats and basic groups), never a supergroup's or a
 * channel's. With `keepDisappearing` on, a message on an auto-delete timer is
 * kept when the delete is the timer's own (see `isExpiry`): it is marked kept
 * and its expiry moves up to now, with no tombstone. Every other message is
 * removed with its earlier versions, and a tombstone is written, also when no
 * message matched, so that a message arriving later is dropped. A view-once
 * message without a timer has no expiry to match, so it is removed.
 */
export function deleteMessages(mirror: Mirror, ctx: IngestContext, del: DeleteInput): DeleteOutcome[] {
  if (del.chat !== null && !isChatId(del.chat)) return []
  const gaps = ctx.keepDisappearing ? loadGaps(mirror) : []
  const outcomes: DeleteOutcome[] = []
  for (const id of del.ids) {
    if (!isCount(id) || id === 0) continue
    let removed = 0
    let kept = 0
    for (const target of targetsOf(mirror, del.chat, id)) {
      if (ctx.keepDisappearing && isExpiry(target.expires, ctx.now, gaps)) {
        mirror
          .prepare("UPDATE messages SET kept = 1, expires = MIN(expires, ?) WHERE chat = ? AND id = ?")
          .run(ctx.now, target.chat, id)
        kept++
      } else {
        removeMessage(mirror, target.chat, id)
        removed++
      }
    }
    if (kept === 0) recordDeleted(mirror, del.chat, id, ctx.now)
    outcomes.push(kept > 0 ? "kept" : removed > 0 ? "removed" : "tombstoned")
  }
  return outcomes
}

/**
 * Lets messages whose timer has run out leave: they are deleted with their
 * earlier versions, or with `keepDisappearing` on marked kept. No tombstone,
 * since Telegram removed them too. Returns how many it changed.
 */
export function expireMessages(mirror: Mirror, ctx: IngestContext): number {
  if (ctx.keepDisappearing) {
    return Number(mirror.prepare("UPDATE messages SET kept = 1 WHERE expires <= ? AND kept = 0").run(ctx.now).changes)
  }
  mirror
    .prepare("DELETE FROM edits WHERE (chat, id) IN (SELECT chat, id FROM messages WHERE expires <= ?)")
    .run(ctx.now)
  return Number(mirror.prepare("DELETE FROM messages WHERE expires <= ?").run(ctx.now).changes)
}

/** Records a span the sync service was not watching, so deletes made in it, which may arrive late, are not mistaken for timers. Does nothing for a span that is empty or not in order. */
export function recordGap(mirror: Mirror, start: number, until: number): void {
  if (!isCount(start) || !isCount(until) || until <= start) return
  mirror.prepare("INSERT INTO gaps (start, until) VALUES (?, ?)").run(start, until)
}

/** Forgets tombstones older than `TOMBSTONE_TTL_MS` and gaps older than `GAP_TTL_MS`. */
export function purge(mirror: Mirror, now: number): void {
  mirror.prepare("DELETE FROM deleted WHERE at <= ?").run(now - TOMBSTONE_TTL_MS)
  mirror.prepare("DELETE FROM gaps WHERE until <= ?").run(now - GAP_TTL_MS)
}
