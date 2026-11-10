import { requireChatId } from "../chat/chat-rows"
import { pickPaths, readMirror } from "../chat/open"
import { callService } from "../telegram/service"
import {
  CAPTION_MAX_UNITS,
  type EditParams,
  type EditResult,
  SERVICE_REQUESTS,
  TEXT_MAX_UNITS,
} from "../telegram/service-requests"
import { defineTool } from "../tool"
import { EDIT_HEADLINES, describeAction } from "./action-describe"
import { editInput, editOutput, type EditOutput } from "./action-schema"
import { actionTargets } from "./action-targets"
import { checkedText } from "./arguments"
import { ACTION_TIMEOUT_MS, MESSAGE_EDIT_TOOL_ID } from "./constants"
import { prepareEdit } from "./edit-prepare"
import { editResult } from "./result"

/** The `telegram_message_edit` tool definition. */
export const telegramMessageEdit = defineTool({
  id: MESSAGE_EDIT_TOOL_ID,
  title: "Edit a message",
  description: [
    "Edits one of the user's own messages: replaces its text, or the caption of a message with media, for everyone in the chat.",
    "`chat` is a chat id from `telegram_chat_read`, never a name, username or phone number; `id` is the message's id from `telegram_chat_read`.",
    `\`text\` is the whole new text, exactly as written, never read as Markdown or HTML, surrounding blank space trimmed, at most ${TEXT_MAX_UNITS} characters (${CAPTION_MAX_UNITS} for a caption).`,
    "Only the user's own messages can be edited, and only within the time Telegram allows an edit. It is refused for another person's message, a message with no text or caption, one already deleted, a chat the user has left, and a text that changes nothing.",
    "Needs the sync service running, and the `actions` toolset, which is off by default. The mirror keeps the earlier version, which `telegram_chat_read` shows as `earlier_versions`.",
    "A result means Telegram accepted the edit; the chat shows the new text, marked edited. `already` means the message already had this text because an earlier delivery of this same edit went through: it must not be edited again.",
    "A failure `uncertain` means the edit may have gone through: check the chat in Telegram and never ask for it again without the user checking.",
  ].join(" "),
  intent: "About to edit a message",
  toolset: "actions",
  class: "overwrite",
  input: editInput,
  output: editOutput,
  async describe(args, ctx) {
    const text = checkedText(args.text)
    const chat = requireChatId(args.chat, MESSAGE_EDIT_TOOL_ID)
    const paths = await pickPaths(ctx, args.account)
    const target = readMirror(paths, (mirror) => prepareEdit(mirror, chat, args.id, text))
    return {
      ...describeAction(EDIT_HEADLINES, target.chat, args.id, target.message),
      text: { label: "New text", body: text },
    }
  },
  targets: (args, ctx) => actionTargets(MESSAGE_EDIT_TOOL_ID, args, ctx),
  async execute(args, ctx): Promise<EditOutput> {
    const chat = requireChatId(args.chat, MESSAGE_EDIT_TOOL_ID)
    const text = checkedText(args.text)
    const paths = await pickPaths(ctx, args.account)
    readMirror(paths, (mirror) => prepareEdit(mirror, chat, args.id, text))

    const params: EditParams = { chat, id: args.id, text }
    const edited = await callService<EditResult>(paths.socket, SERVICE_REQUESTS.edit, params, {
      effect: "write",
      signal: ctx.signal,
      timeoutMs: ACTION_TIMEOUT_MS,
    })
    return editResult(chat, edited)
  },
})
