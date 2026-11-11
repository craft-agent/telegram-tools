import { z } from "zod"
import { pickPaths } from "../open"
import { SYNC_LIST_LIMIT } from "../telegram/service-requests"
import { defineTool } from "../tool"
import { accountTargets, changeInput, requestSyncAdd, requireChatIds } from "./change"
import { describeChange } from "./describe"
import { chatIdsField, limitField, sizeField } from "./schema"

const TOOL_ID = "telegram_sync_add"

const output = z.object({
  added: chatIdsField("The chats now on the sync list that were not on it before; they are being seeded."),
  listed: chatIdsField("The chats that were already on the sync list; nothing changed for them."),
  size: sizeField,
  limit: limitField,
  note: z.string().describe("What happens to the added chats and how to read them."),
})

const NOTE =
  "Added chats are seeded with their newest 50 messages within seconds while the sync service runs, then kept current. Older history comes from `telegram_chat_read` method `fetch`; read the chats with `telegram_chat_read`."

/** The `telegram_sync_add` tool definition. */
export const telegramSyncAdd = defineTool({
  id: TOOL_ID,
  title: "Add chats to the sync list",
  description: [
    "Puts supergroups and channels on the sync list, so the mirror keeps their messages from now on.",
    "Changes only the local mirror and the sync list; nothing changes at Telegram. Needs the sync service running.",
    `The list holds at most ${SYNC_LIST_LIMIT} chats. The whole call is refused when any chat cannot be listed: private chats, bots, basic groups and Saved Messages are always kept, and channels can be listed only with the channels setting on.`,
    "Chats come as ids from `telegram_chat_read` method `list`, never names.",
    "A chat already on the list is reported under `listed` and left as it is, so repeating a call is harmless. If the call ends `uncertain`, check `telegram_sync_read` before trying again.",
  ].join(" "),
  toolset: "sync",
  intent: "About to add chats to the sync list",
  class: "idempotent",
  targets: accountTargets,
  input: changeInput,
  output,
  describe: (args, ctx) =>
    describeChange(args, ctx, TOOL_ID, {
      one: "About to add {chat} to the sync list",
    }),
  async execute(args, ctx) {
    const chats = requireChatIds(args.chats, TOOL_ID)
    const paths = await pickPaths(ctx, args.account)
    const { added, listed, size } = await requestSyncAdd(paths.socket, { chats }, ctx.signal)
    return { added, listed, size, limit: SYNC_LIST_LIMIT, note: NOTE }
  },
})
