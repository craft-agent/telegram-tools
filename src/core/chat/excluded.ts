import { ToolError } from "../errors"
import type { ToolContext } from "../tool"
import { placeholders } from "./sql"

const CANONICAL_CHAT_ID = /^-?[1-9]\d*$/
const INVALID_SETTING_MESSAGE =
  "The exclude_chats setting holds an entry that is not a chat id; set it to chat ids as list gives them."

/**
 * The chats the `exclude_chats` setting keeps out of every tool; empty when it
 * is unset. An entry that is not a chat id throws `invalid_argument` without
 * repeating it, so a typo stops the tools instead of leaving a chat open.
 */
export function excludedChats(ctx: Pick<ToolContext, "options">): ReadonlySet<string> {
  const chats = ctx.options?.exclude_chats
  if (chats === undefined) return new Set()
  if (!Array.isArray(chats) || chats.some((chat) => typeof chat !== "string" || !CANONICAL_CHAT_ID.test(chat))) {
    throw new ToolError("invalid_argument", INVALID_SETTING_MESSAGE)
  }
  return new Set(chats)
}

/**
 * Throws `refusal` of the first of `chats` the setting excludes. The refusal is
 * the error the tool gives for a chat it does not know, so an excluded chat
 * cannot be told from an unknown one.
 */
export function refuseExcludedChats(
  ctx: Pick<ToolContext, "options">,
  chats: readonly string[],
  refusal: (chat: string) => ToolError,
): void {
  const excluded = excludedChats(ctx)
  const chat = chats.find((id) => excluded.has(id))
  if (chat !== undefined) throw refusal(chat)
}

/** A SQL condition that leaves the excluded chats out of `column`, with its parameters; none when nothing is excluded. */
export function excludedCondition(
  column: string,
  excluded: ReadonlySet<string>,
): { sql: string; params: string[] } | undefined {
  if (excluded.size === 0) return undefined
  return { sql: `${column} NOT IN (${placeholders(excluded.size)})`, params: [...excluded] }
}
