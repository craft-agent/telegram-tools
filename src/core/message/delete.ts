import { requireChatId } from "../chat/chat-rows"
import { pickPaths, readMirror } from "../open"
import { callService } from "../telegram/service"
import { type DeleteParams, type DeleteResult, SERVICE_REQUESTS } from "../telegram/service-requests"
import { confirmWrite, defineTool } from "../tool"
import { DELETE_HEADLINES, describeAction } from "./action-describe"
import { deleteInput, deleteOutput, type DeleteOutput } from "./action-schema"
import { actionTargets } from "./action-targets"
import { ACTION_TIMEOUT_MS, MESSAGE_DELETE_TOOL_ID } from "./constants"
import { findOwnMessage } from "./own"
import { deleteResult } from "./result"

/** The `telegram_message_delete` tool definition. */
export const telegramMessageDelete = defineTool({
  id: MESSAGE_DELETE_TOOL_ID,
  title: "Delete a message for everyone",
  description: [
    "Deletes one of the user's own messages for everyone in the chat. It cannot be undone, and there is no delete for the user alone.",
    "`chat` is a chat id from `telegram_chat_read`, never a name, username or phone number; `id` is the message's id from `telegram_chat_read`.",
    "Only the user's own messages can be deleted: another person's message and a chat the user has left are refused. A message already deleted is reported as `already`, not as a failure.",
    "Needs the sync service running, and the `actions` toolset, which is off by default. The message, its files and its earlier versions leave the mirror too.",
    "A result means Telegram deleted the message for everyone. `already` means it was gone before this call.",
    "A failure `uncertain` means the delete may have gone through: check the chat in Telegram and never ask for it again without the user checking.",
  ].join(" "),
  intent: "About to delete a message",
  toolset: "actions",
  class: "administrative",
  input: deleteInput,
  output: deleteOutput,
  async describe(args, ctx) {
    const chat = requireChatId(args.chat, MESSAGE_DELETE_TOOL_ID)
    const paths = await pickPaths(ctx, args.account)
    const target = readMirror(paths, (mirror) => findOwnMessage(mirror, chat, args.id, "delete"))
    return describeAction(DELETE_HEADLINES, target.chat, args.id, target.message)
  },
  targets: (args, ctx) => actionTargets(MESSAGE_DELETE_TOOL_ID, args, ctx),
  async execute(args, ctx): Promise<DeleteOutput> {
    const chat = requireChatId(args.chat, MESSAGE_DELETE_TOOL_ID)
    const paths = await pickPaths(ctx, args.account)
    readMirror(paths, (mirror) => findOwnMessage(mirror, chat, args.id, "delete"))
    await confirmWrite(
      telegramMessageDelete,
      ctx,
      `Delete message ${args.id} in chat ${chat} for everyone? It cannot be undone.`,
    )

    const params: DeleteParams = { chat, id: args.id }
    const deleted = await callService<DeleteResult>(paths.socket, SERVICE_REQUESTS.delete, params, {
      effect: "write",
      signal: ctx.signal,
      timeoutMs: ACTION_TIMEOUT_MS,
    })
    return deleteResult(chat, deleted)
  },
})
