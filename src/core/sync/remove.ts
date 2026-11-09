import { z } from "zod"
import { pickPaths } from "../chat/open"
import { SYNC_LIST_LIMIT } from "../telegram/service-requests"
import { defineTool } from "../tool"
import { accountTargets, changeInput, requestSyncRemove, requireChatIds } from "./change"
import { describeChange } from "./describe"
import { chatIdsField, limitField, sizeField } from "./schema"

const TOOL_ID = "telegram_sync_remove"

const output = z.object({
  removed: chatIdsField("The chats taken off the sync list; their mirrored messages and earlier versions are gone."),
  absent: chatIdsField("The chats that were not on the sync list; nothing changed for them."),
  size: sizeField,
  limit: limitField,
  note: z.string().describe("What happens to the removed chats and how to read them."),
})

const NOTE =
  "Removed chats lost their mirrored messages and earlier versions. They can still be read live with `telegram_chat_read` methods `view` and `around`."

/** The `telegram_sync_remove` tool definition. */
export const telegramSyncRemove = defineTool({
  id: TOOL_ID,
  title: "Remove chats from the sync list",
  description: [
    "Takes supergroups and channels off the sync list, so the mirror stops keeping their messages and deletes the ones it holds, with their earlier versions.",
    "Changes only the local mirror and the sync list; nothing changes at Telegram. Needs the sync service running.",
    `The list holds at most ${SYNC_LIST_LIMIT} chats. The whole call is refused when any chat cannot be listed: private chats, bots, basic groups and Saved Messages are always kept, and channels can be listed only with the channels setting on.`,
    "Chats come as ids from `telegram_chat_read` method `list`, never names.",
    "A chat that is not on the list is reported under `absent`, so repeating a call is harmless. If the call ends `uncertain`, check `telegram_sync_read` before trying again.",
  ].join(" "),
  toolset: "sync",
  intent: "About to remove chats from the sync list",
  class: "overwrite",
  targets: accountTargets,
  input: changeInput,
  output,
  describe: (args, ctx) =>
    describeChange(args, ctx, TOOL_ID, {
      one: "About to remove {chat} from the sync list",
      facts: [{ label: "Mirrored messages", value: { text: "Deleted" } }],
    }),
  async execute(args, ctx) {
    const chats = requireChatIds(args.chats, TOOL_ID)
    const paths = await pickPaths(ctx, args.account)
    const { removed, absent, size } = await requestSyncRemove(paths.socket, { chats }, ctx.signal)
    return { removed, absent, size, limit: SYNC_LIST_LIMIT, note: NOTE }
  },
})
