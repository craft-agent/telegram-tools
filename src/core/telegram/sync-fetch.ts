import type { Message } from "@mtcute/core"
import { messageInputOf, topicInputOfAction } from "./from-mtcute"
import { upsertChats, upsertTopics } from "./ingest-chats"
import { storeMessage } from "./ingest-messages"
import { inTransaction, type Mirror } from "./mirror"
import type { ChatInput, MessageInput, TopicInput } from "./mirror-input"
import { findChat } from "./mirror-rows"
import { floodWaitSecondsOf, isSessionEnded } from "./rpc-errors"
import { StorageFailure, writing } from "./sync-ending"
import type { ResolvedSyncOptions } from "./sync-options"
import { errorLabel } from "./sync-outcome"
import type { SyncTelegram } from "./sync-telegram"
import { waitThrough } from "./sync-wait"

/** What the background work needs: the client, the mirror, the settings, and the signal that ends it. */
export type BackgroundContext = {
  client: SyncTelegram
  mirror: Mirror
  settings: ResolvedSyncOptions
  signal: AbortSignal
}

/** How many times each chat was tried for seeding; a chat that was seeded counts as tried out. */
export type SeedTries = Map<string, number>

/** A fetched message as the mirror takes it, with the topic it created or edited. */
type Fetched = { message: MessageInput; topic: TopicInput | null }

async function pace({ settings, signal }: BackgroundContext): Promise<void> {
  const [shortest, longest] = settings.paceMs
  await waitThrough(settings.pause, shortest + Math.random() * (longest - shortest), signal)
}

/**
 * What a failed background call does. What ends the service (Telegram ending
 * the session, a mirror that cannot be written) is rethrown. A flood wait is
 * waited out, cut short by the stop signal; anything else is logged by its
 * name and left for the next round. Returns whether the failure was a flood
 * wait.
 */
export async function failedCall(ctx: BackgroundContext, error: unknown, what: string): Promise<boolean> {
  if (isSessionEnded(error) || error instanceof StorageFailure) throw error
  if (ctx.signal.aborted) return false
  const { log, pause } = ctx.settings
  const seconds = floodWaitSecondsOf(error)
  if (seconds === undefined) {
    log(`${what} failed: ${errorLabel(error)}`)
    return false
  }
  log(`${what}: flood wait of ${seconds} seconds`)
  await waitThrough(pause, seconds * 1000, ctx.signal)
  return true
}

/**
 * A chat's history after a pause; null when the call failed (handled) or the
 * service is stopping. `onFloodWait` is called when the failure was a flood
 * wait, which has been waited out by then.
 */
async function fetchHistory(
  ctx: BackgroundContext,
  chat: string,
  params: { limit: number; minId?: number },
  what: string,
  onFloodWait?: () => void,
): Promise<Message[] | null> {
  await pace(ctx)
  if (ctx.signal.aborted) return null
  try {
    // A marked id is at most 13 digits, so a number holds it exactly.
    return await ctx.client.getHistory(Number(chat), params)
  } catch (error) {
    if (await failedCall(ctx, error, what)) onFloodWait?.()
    return null
  }
}

/** The fetched messages of `chat` the mirror can take, oldest first; a message that cannot be read is left out. */
function readFetched(chat: string, messages: Message[]): Fetched[] {
  const fetched: Fetched[] = []
  for (const message of messages) {
    try {
      const input = messageInputOf(message)
      if (input && input.chat === chat) fetched.push({ message: input, topic: topicInputOfAction(message) })
    } catch {
      // One unreadable message does not cost the rest.
    }
  }
  return fetched.sort((a, b) => a.message.id - b.message.id)
}

/**
 * Stores fetched messages of a followed chat in one transaction; returns how
 * many were new. Storing a new incoming message past the read position adds
 * one to the chat's `unread`, which is right for a pushed message but not for
 * one fetched after the dialog list gave the count, so that is undone.
 */
function storeFetched(ctx: BackgroundContext, chat: string, messages: Message[]): number {
  const { mirror, settings } = ctx
  const fetched = readFetched(chat, messages)
  return writing(() =>
    inTransaction(mirror, () => {
      const row = findChat(mirror, chat)
      if (!row?.followed) return 0
      const now = settings.now()
      const ingest = { now, keepDisappearing: settings.keepDisappearing }
      let stored = 0
      let unreadAdded = 0
      for (const { message, topic } of fetched) {
        if (topic) upsertTopics(mirror, [topic], now)
        if (storeMessage(mirror, ingest, message) !== "stored") continue
        stored++
        if (!message.fromMe && message.id > (row.read_max ?? 0)) unreadAdded++
      }
      if (unreadAdded > 0) {
        upsertChats(
          mirror,
          [{ id: row.id, kind: row.kind, name: row.name, username: row.username, unread: row.unread }],
          now,
        )
      }
      return stored
    }),
  )
}

/** The newest stored message id of a chat, or null when it has none. */
function newestStored(mirror: Mirror, chat: string): number | null {
  const row = mirror.prepare("SELECT MAX(id) AS id FROM messages WHERE chat = ?").get(chat) as { id: number | null }
  return row.id
}

/** The followed chats with no stored messages whose last activity is at or after `since`, the most recent first. */
function seedCandidates(mirror: Mirror, since: number): string[] {
  const rows = mirror
    .prepare(
      `SELECT id FROM chats
       WHERE followed = 1 AND last_ts >= ? AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.chat = chats.id)
       ORDER BY last_ts DESC`,
    )
    .all(since) as { id: string }[]
  return rows.map((row) => row.id)
}

/**
 * Fills the gaps in followed chats whose dialog shows a newer message than the
 * newest stored one: up to `fillLimit` of the newest messages above it. A chat
 * with no stored message is seeded, not filled. Returns how many messages were
 * new.
 */
export async function fillGaps(ctx: BackgroundContext, dialogs: ChatInput[]): Promise<number> {
  const { mirror, settings, signal } = ctx
  let filled = 0
  for (const dialog of dialogs) {
    if (signal.aborted) break
    if (dialog.topId == null || !findChat(mirror, dialog.id)?.followed) continue
    const newest = newestStored(mirror, dialog.id)
    if (newest === null || dialog.topId <= newest) continue
    const messages = await fetchHistory(ctx, dialog.id, { minId: newest, limit: settings.fillLimit }, "gap fill")
    if (messages) filled += storeFetched(ctx, dialog.id, messages)
  }
  return filled
}

/**
 * One seeding round: followed chats with no stored messages and some activity
 * within `seedWithinMs` get their newest `seedCount` messages, at most
 * `seedChatsPerRound` chats. A failed chat is tried again next round, up to
 * `seedAttempts` times; a flood wait is waited out and does not count as a
 * try. Returns how many chats were seeded.
 */
export async function seedRound(ctx: BackgroundContext, tries: SeedTries): Promise<number> {
  const { mirror, settings, signal } = ctx
  const waiting = seedCandidates(mirror, settings.now() - settings.seedWithinMs)
    .filter((chat) => (tries.get(chat) ?? 0) < settings.seedAttempts)
    .slice(0, settings.seedChatsPerRound)
  let seeded = 0
  for (const chat of waiting) {
    if (signal.aborted) break
    let flooded = false
    const messages = await fetchHistory(ctx, chat, { limit: settings.seedCount }, "seeding", () => {
      flooded = true
    })
    if (!messages) {
      if (!flooded) tries.set(chat, (tries.get(chat) ?? 0) + 1)
      continue
    }
    storeFetched(ctx, chat, messages)
    tries.set(chat, settings.seedAttempts)
    seeded++
  }
  return seeded
}
