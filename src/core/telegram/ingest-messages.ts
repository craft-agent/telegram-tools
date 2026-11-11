import { MS_PER_S } from "../time"
import { isCount, isMessageInput, type IngestContext, type MessageInput } from "./mirror-input"
import type { Mirror } from "./mirror"
import { findChat, isDeleted, toJson } from "./mirror-rows"

/** What `storeMessage` did, as a kind a log can carry: never content or ids. */
export type StoreOutcome =
  "stored" | "edited" | "unchanged" | "expired" | "dropped-deleted" | "dropped-unfollowed" | "skipped"

/** What the stored version of a message needs to be compared with an incoming one and kept as history. */
type StoredVersion = {
  ts: number
  body: string | null
  entities: string | null
  media: string | null
  edited: number | null
  expires: number | null
}

/** When the message disappears by its chat's timer, or null. */
function expiryOf(msg: MessageInput): number | null {
  return isCount(msg.ttl) && msg.ttl > 0 ? msg.ts + msg.ttl * MS_PER_S : null
}

function findVersion(mirror: Mirror, chat: string, id: number): StoredVersion | null {
  const row = mirror
    .prepare("SELECT ts, body, entities, media, edited, expires FROM messages WHERE chat = ? AND id = ?")
    .get(chat, id)
  return (row as StoredVersion | undefined) ?? null
}

/**
 * Records a new message in its chat: the newest known message moves forward
 * and never back, and an incoming message past `read_max` adds one to `unread`.
 */
function touchChat(mirror: Mirror, msg: MessageInput): void {
  mirror
    .prepare(
      `UPDATE chats SET top_id = MAX(COALESCE(top_id, 0), ?), last_ts = MAX(COALESCE(last_ts, 0), ?),
         unread = unread + CASE WHEN ? = 0 AND ? > COALESCE(read_max, 0) THEN 1 ELSE 0 END
       WHERE id = ?`,
    )
    .run(msg.id, msg.ts, Number(msg.fromMe), msg.id, msg.chat)
}

/** Sets the reactions when the input knows them; an empty list clears them. */
function setReactions(mirror: Mirror, msg: MessageInput): void {
  if (msg.reactions === null) return
  mirror
    .prepare("UPDATE messages SET reactions = ? WHERE chat = ? AND id = ?")
    .run(toJson(msg.reactions), msg.chat, msg.id)
}

function insertMessage(mirror: Mirror, ctx: IngestContext, msg: MessageInput, expires: number | null): void {
  const kept = ctx.keepDisappearing && expires !== null && expires <= ctx.now
  mirror
    .prepare(
      `INSERT INTO messages (chat, id, topic, ts, from_me, sender, sender_name, kind, body, entities, media, action,
         reply, forward, grouped, reactions, edited, expires, view_once, self_destruct, kept, received)
       VALUES (:chat, :id, :topic, :ts, :from_me, :sender, :sender_name, :kind, :body, :entities, :media, :action,
         :reply, :forward, :grouped, :reactions, :edited, :expires, :view_once, :self_destruct, :kept, :received)`,
    )
    .run({
      chat: msg.chat,
      id: msg.id,
      topic: isCount(msg.topic) ? msg.topic : null,
      ts: msg.ts,
      from_me: Number(msg.fromMe),
      sender: msg.sender ?? null,
      sender_name: msg.senderName ?? null,
      kind: msg.kind,
      body: msg.body ?? null,
      entities: toJson(msg.entities),
      media: toJson(msg.media),
      action: toJson(msg.action),
      reply: toJson(msg.reply),
      forward: toJson(msg.forward),
      grouped: msg.grouped ?? null,
      reactions: toJson(msg.reactions),
      edited: isCount(msg.edited) ? msg.edited : null,
      expires,
      view_once: Number(msg.viewOnce),
      self_destruct: isCount(msg.selfDestruct) ? msg.selfDestruct : null,
      kept: Number(kept),
      received: ctx.now,
    })
}

/**
 * A message the mirror already has: when the input is a newer edit, the stored
 * version goes to `edits` and the message takes the new body, entities and
 * media; an older or equal version changes nothing but the reactions, when it
 * gives them.
 */
function updateMessage(mirror: Mirror, stored: StoredVersion, msg: MessageInput): "edited" | "unchanged" {
  const edited = isCount(msg.edited) ? msg.edited : null
  const isNewer = edited !== null && (stored.edited === null || edited > stored.edited)
  if (isNewer) {
    mirror
      .prepare(
        `INSERT INTO edits (chat, id, seq, at, body, entities, media)
        SELECT ?, ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ? FROM edits WHERE chat = ? AND id = ?`,
      )
      .run(msg.chat, msg.id, stored.edited ?? stored.ts, stored.body, stored.entities, stored.media, msg.chat, msg.id)
    mirror
      .prepare("UPDATE messages SET body = ?, entities = ?, media = ?, edited = ? WHERE chat = ? AND id = ?")
      .run(msg.body ?? null, toJson(msg.entities), toJson(msg.media), edited, msg.chat, msg.id)
  }
  setReactions(mirror, msg)
  return isNewer ? "edited" : "unchanged"
}

/**
 * Stores one message, or applies it as an edit when the mirror has it.
 *
 * It is dropped when its chat is unknown or not followed (the caller upserts
 * the chat first), and when a delete for everyone was seen for it. A new one
 * that already disappeared is not stored unless `keepDisappearing` is on, in
 * which case it is stored as kept. Storing a new message moves the chat's
 * `top_id` and `last_ts` forward, and adds one to its `unread` when the message
 * is incoming and past `read_max`. Malformed input is skipped. An existing
 * expired message leaves with its earlier versions unless keeping is on.
 */
export function storeMessage(mirror: Mirror, ctx: IngestContext, msg: MessageInput): StoreOutcome {
  if (!isMessageInput(msg)) return "skipped"
  const chat = findChat(mirror, msg.chat)
  if (!chat?.followed) return "dropped-unfollowed"
  if (isDeleted(mirror, chat, msg.id)) return "dropped-deleted"
  const stored = findVersion(mirror, msg.chat, msg.id)
  if (stored) {
    if (stored.expires !== null && stored.expires <= ctx.now) {
      if (!ctx.keepDisappearing) {
        mirror.prepare("DELETE FROM edits WHERE chat = ? AND id = ?").run(msg.chat, msg.id)
        mirror.prepare("DELETE FROM messages WHERE chat = ? AND id = ?").run(msg.chat, msg.id)
        return "expired"
      }
      mirror.prepare("UPDATE messages SET kept = 1 WHERE chat = ? AND id = ?").run(msg.chat, msg.id)
    }
    return updateMessage(mirror, stored, msg)
  }
  const expires = expiryOf(msg)
  if (expires !== null && expires <= ctx.now && !ctx.keepDisappearing) return "expired"
  insertMessage(mirror, ctx, msg, expires)
  touchChat(mirror, msg)
  return "stored"
}
