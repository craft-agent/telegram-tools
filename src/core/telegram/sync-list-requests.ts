import { ToolError } from "../errors"
import { inTransaction, type Mirror } from "./mirror"
import { findChat } from "./mirror-rows"
import { SYNC_LIST_LIMIT, type SyncAddResult, type SyncRemoveResult } from "./service-requests"
import { writing } from "./sync-ending"
import { isListable, isListed, listChat, listSize, unlistChat } from "./sync-list"
import type { ResolvedSyncOptions } from "./sync-options"
import { parseSyncChangeParams } from "./sync-request-params"

export const UNKNOWN_SYNC_CHAT_MESSAGE = (id: string): string =>
  `The chat list has no chat ${id}; refresh it, or check the id.`

/** What the sync list requests work with; the sync requests' context holds all of it. */
export type SyncListContext = {
  mirror: Mirror
  settings: Pick<ResolvedSyncOptions, "channels" | "now">
  /** Ends the run for a failure of the service's own, such as a mirror that cannot be written. */
  failRun(error: unknown): void
  /** Removes the kept files of chats whose messages the mirror no longer has. */
  forgetChats(chats: readonly string[]): void
}

/** Refuses the whole call unless every chat is one the mirror lists and the sync list can hold. */
function expectListable({ mirror, settings }: SyncListContext, chats: string[]): void {
  for (const id of chats) {
    const row = findChat(mirror, id)
    if (!row) throw new ToolError("not_found", UNKNOWN_SYNC_CHAT_MESSAGE(id))
    if (!isListable(row.kind)) {
      throw new ToolError(
        "invalid_argument",
        `${id} is always mirrored: the sync list is for supergroups and channels.`,
      )
    }
    if (row.kind === "channel" && !settings.channels) {
      throw new ToolError("invalid_argument", "Channels are off; turn the channels setting on to list them.")
    }
  }
}

/** Writes the sync list in one transaction; a mirror that cannot be written ends the run, as for a history fetch. */
function writeList<T>(ctx: SyncListContext, change: () => T): T {
  try {
    return writing(() => inTransaction(ctx.mirror, change))
  } catch (error) {
    ctx.failRun(error)
    throw error
  }
}

/**
 * Puts chats on the sync list and follows them; the housekeeping's next round
 * seeds them. The checks and the write run without waiting, so the list cannot
 * change between them.
 */
export async function syncAdd(ctx: SyncListContext, raw: unknown): Promise<SyncAddResult> {
  const { chats } = parseSyncChangeParams(raw)
  expectListable(ctx, chats)
  const { mirror, settings } = ctx
  const listed = chats.filter((chat) => isListed(mirror, chat))
  if (listSize(mirror) + chats.length - listed.length > SYNC_LIST_LIMIT) {
    throw new ToolError("invalid_argument", `The sync list holds at most ${SYNC_LIST_LIMIT} chats; remove some first.`)
  }
  return writeList(ctx, () => {
    const now = settings.now()
    const added = chats.filter((chat) => listChat(mirror, chat, now))
    return { added, listed, size: listSize(mirror) }
  })
}

/** Takes chats off the sync list and stops following them, deleting their mirrored messages and the files kept of them. */
export async function syncRemove(ctx: SyncListContext, raw: unknown): Promise<SyncRemoveResult> {
  const { chats } = parseSyncChangeParams(raw)
  expectListable(ctx, chats)
  const { mirror } = ctx
  const result = writeList(ctx, () => {
    const removed = chats.filter((chat) => unlistChat(mirror, chat))
    return { removed, absent: chats.filter((chat) => !removed.includes(chat)), size: listSize(mirror) }
  })
  if (result.removed.length > 0) ctx.forgetChats(result.removed)
  return result
}
