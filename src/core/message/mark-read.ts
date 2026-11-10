import { requireChatId } from "../chat/chat-rows"
import { pickPaths, readMirror } from "../chat/open"
import { callService } from "../telegram/service"
import { type MarkReadParams, type MarkReadResult, SERVICE_REQUESTS } from "../telegram/service-requests"
import { defineTool } from "../tool"
import { describeMarkRead } from "./action-describe"
import { markReadInput, markReadOutput, type MarkReadOutput } from "./action-schema"
import { chatTargets } from "./action-targets"
import { ACTION_TIMEOUT_MS, CHAT_MARK_READ_TOOL_ID } from "./constants"
import { prepareMarkRead } from "./mark-read-prepare"
import { markReadResult } from "./result"

/** The `telegram_chat_mark_read` tool definition. */
export const telegramChatMarkRead = defineTool({
  id: CHAT_MARK_READ_TOOL_ID,
  title: "Mark a chat read",
  description: [
    "Marks a chat, or one forum topic of it (`topic`), read up to a message (`up_to`), never further and never back: later messages stay unread, and a chat already read that far is left as it is.",
    "Only when the user asks for it: reading through the tools never marks anything read, and this is the one tool that does.",
    "The senders see their messages as read, and the notifications on the user's phone and other devices clear.",
    "`chat` is a chat id from `telegram_chat_read`, never a name, username or phone number; `up_to` is the id of the last message to mark read, from `telegram_chat_read`, a message of that chat (of that topic, with `topic`) that the mirror holds.",
    "It is refused for a message not in the mirror or already deleted, for a chat the user has left, and for a `topic` in a chat without topics.",
    "Needs the sync service running, and the `actions` toolset, which is off by default.",
    "A result means Telegram marked the messages read up to `up_to`. `already` means the chat was already read that far, so nothing was asked of Telegram.",
    "A failure `uncertain` means the read mark may have gone through: check the chat in Telegram and never ask for it again without the user checking.",
  ].join(" "),
  intent: "About to mark messages read",
  toolset: "actions",
  class: "idempotent",
  input: markReadInput,
  output: markReadOutput,
  async describe(args, ctx) {
    const chat = requireChatId(args.chat, CHAT_MARK_READ_TOOL_ID)
    const paths = await pickPaths(ctx, args.account)
    const target = readMirror(paths, (mirror) => prepareMarkRead(mirror, chat, args))
    return describeMarkRead(target.chat, args.up_to, { id: args.topic, title: target.topicTitle })
  },
  targets: (args, ctx) => chatTargets(CHAT_MARK_READ_TOOL_ID, args, ctx),
  async execute(args, ctx): Promise<MarkReadOutput> {
    const chat = requireChatId(args.chat, CHAT_MARK_READ_TOOL_ID)
    const paths = await pickPaths(ctx, args.account)
    readMirror(paths, (mirror) => prepareMarkRead(mirror, chat, args))

    const params: MarkReadParams = { chat, up_to: args.up_to, ...(args.topic !== undefined && { topic: args.topic }) }
    const read = await callService<MarkReadResult>(paths.socket, SERVICE_REQUESTS.markRead, params, {
      effect: "write",
      signal: ctx.signal,
      timeoutMs: ACTION_TIMEOUT_MS,
    })
    return markReadResult(read)
  },
})
