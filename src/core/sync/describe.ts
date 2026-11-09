import { existingChat } from "../chat/chat-rows"
import { chatFact } from "../chat/facts"
import { pickPaths, readMirror } from "../chat/open"
import type { CallDescription, CallFact, CallHeadline, ToolContext } from "../tool"
import { requireChatIds } from "./change"

/** The words of one tool that changes the sync list, which it keeps beside its own code. */
export type ChangeWords = {
  /** The headline for one named chat, with a `{chat}` placeholder. */
  one: string
  /** The facts the call adds before the `Chat` or `Chats` fact. */
  facts?: CallFact[]
}

/** The approval headline of a change, when it concerns one chat that has a name. */
function changeHeadline(one: string, chat: string | null): CallHeadline | undefined {
  return chat === null ? undefined : { text: one, values: { chat } }
}

/**
 * The approval description of a call that changes the sync list: the chats
 * must be ids the mirror has. One named chat is in the headline, with its kind
 * of chat; several chats are counted in a fact. Chats the headline does not
 * name are listed in the text, one per line.
 */
export async function describeChange(
  args: { account?: string; chats: readonly string[] },
  ctx: ToolContext,
  tool: string,
  words: ChangeWords,
): Promise<CallDescription> {
  const ids = requireChatIds(args.chats, tool)
  const paths = await pickPaths(ctx, args.account)
  const rows = readMirror(paths, (mirror) => ids.map((id) => existingChat(mirror, id)))
  const only = rows.length === 1 ? rows[0] : undefined
  const headline = changeHeadline(words.one, only?.name ?? null)
  return {
    ...(headline && { headline }),
    facts: [...(words.facts ?? []), only ? chatFact(only.kind) : { label: "Chats", value: String(rows.length) }],
    ...(!headline && {
      text: {
        label: "Chat list",
        body: rows.map((row) => (row.name === null ? row.id : `${row.name} (${row.id})`)).join("\n"),
      },
    }),
  }
}
