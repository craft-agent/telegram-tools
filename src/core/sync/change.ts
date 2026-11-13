import { z } from "zod"
import { requireChatId } from "../chat/chat-rows"
import { refuseExcludedChats } from "../chat/excluded"
import { UNKNOWN_SYNC_CHAT_MESSAGE } from "../telegram/sync-list-requests"
import { pickPaths } from "../open"
import { ToolError } from "../errors"
import { callService } from "../telegram/service"
import {
  SERVICE_REQUESTS,
  SYNC_LIST_LIMIT,
  type SyncAddResult,
  type SyncChangeParams,
  type SyncRemoveResult,
} from "../telegram/service-requests"
import type { ToolContext } from "../tool"
import { accountArgument } from "./schema"

/** The `chats` argument of the tools that change the sync list. */
export const chatsArgument = z
  .array(z.string())
  .min(1, "chats must name at least one chat id, taken from telegram_chat_read list.")
  .max(SYNC_LIST_LIMIT, `chats can name at most ${SYNC_LIST_LIMIT} chats, as many as the sync list holds.`)
  .describe(
    `The chats to change, by id from \`telegram_chat_read\` method \`list\`, such as -1001234567890: 1 to ${SYNC_LIST_LIMIT} distinct ids. A name, username or phone number is not a chat.`,
  )

/** The input schema for tools that change the sync list (`telegram_sync_add`, `telegram_sync_remove`). */
export const changeInput = z.object({
  account: accountArgument,
  chats: chatsArgument,
})

export function gateChange(args: z.output<typeof changeInput>, ctx: ToolContext): void {
  refuseExcludedChats(ctx, args.chats, (chat) => new ToolError("not_found", UNKNOWN_SYNC_CHAT_MESSAGE(chat)))
}

/** What a call that changes the sync list writes to: the label whose list it is. */
export async function accountTargets(args: { account?: string }, ctx: ToolContext): Promise<string[]> {
  return [(await pickPaths(ctx, args.account)).label]
}

/** The chat ids of a call, each checked as a chat id; a name, a number or a chat named twice is `invalid_argument`. */
export function requireChatIds(chats: readonly string[], tool: string): string[] {
  const seen = new Set<string>()
  for (const chat of chats) {
    requireChatId(chat, tool)
    if (seen.has(chat)) {
      throw new ToolError("invalid_argument", `chats names ${chat} twice; name each chat once.`)
    }
    seen.add(chat)
  }
  return [...chats]
}

/** Puts chats on the sync list; a write, so a reply that is lost is `uncertain`. */
export function requestSyncAdd(socket: string, params: SyncChangeParams, signal?: AbortSignal): Promise<SyncAddResult> {
  return callService<SyncAddResult>(socket, SERVICE_REQUESTS.sync_add, params, { effect: "write", signal })
}

/** Takes chats off the sync list; a write, so a reply that is lost is `uncertain`. */
export function requestSyncRemove(
  socket: string,
  params: SyncChangeParams,
  signal?: AbortSignal,
): Promise<SyncRemoveResult> {
  return callService<SyncRemoveResult>(socket, SERVICE_REQUESTS.sync_remove, params, { effect: "write", signal })
}
