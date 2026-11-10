import { existingChat, requireChatId, topicTitle } from "../chat/chat-rows"
import { chatFact } from "../chat/facts"
import { pickPaths, readMirror } from "../chat/open"
import { isToolError } from "../errors"
import { callService } from "../telegram/service"
import { SERVICE_REQUESTS, type SendParams, type SendResult, TEXT_MAX_UNITS } from "../telegram/service-requests"
import { defineTool } from "../tool"
import { chatTargets } from "./action-targets"
import { checkedText } from "./arguments"
import { MESSAGE_SEND_TOOL_ID, SEND_TIMEOUT_MS } from "./constants"
import { replyFacts, topicFacts } from "./facts"
import { sendResult } from "./result"
import { input, output, type SendOutput } from "./schema"
import { withSentLike } from "./uncertain"

/** The `telegram_message_send` tool definition. */
export const telegramMessageSend = defineTool({
  id: MESSAGE_SEND_TOOL_ID,
  title: "Send a message",
  description: [
    "Sends one text to a chat by id: a person, a group, a forum topic or Saved Messages (the user's own chat), optionally as a reply.",
    "`chat` is a chat id from `telegram_chat_read`, never a name, username or phone number.",
    `\`text\` goes out exactly as written, never read as Markdown or HTML, surrounding blank space trimmed, at most ${TEXT_MAX_UNITS} characters; a longer text is several calls.`,
    "`topic` names a forum topic (an id from `telegram_chat_read` `topics`); `reply_to` replies to a message of that chat by its id.",
    "Needs the sync service running. Sending files is a separate tool.",
    "A result means Telegram accepted the message, not that anyone has read it. `duplicate` means an earlier delivery of this same call had already gone out: it was sent once, and it must not be sent again.",
    "A failure `uncertain` means the message may have gone out: check the chat in Telegram (the error lists the matching messages of the user's that the mirror saw) and never send it again without the user checking.",
  ].join(" "),
  intent: "About to send a message",
  toolset: "sends",
  class: "add",
  input,
  output,
  async describe(args, ctx) {
    const text = checkedText(args.text)
    const chat = requireChatId(args.chat, MESSAGE_SEND_TOOL_ID)
    const paths = await pickPaths(ctx, args.account)
    const { row, title } = readMirror(paths, (mirror) => {
      const found = existingChat(mirror, chat)
      return { row: found, title: args.topic === undefined ? undefined : topicTitle(mirror, chat, args.topic) }
    })
    return {
      ...(row.name !== null && {
        headline: { text: "About to send a message to {chat}", values: { chat: row.name } },
      }),
      facts: [chatFact(row.kind), ...topicFacts(args.topic, title), ...replyFacts(args.reply_to)],
      text: { label: "Message text", body: text },
    }
  },
  targets: (args, ctx) => chatTargets(MESSAGE_SEND_TOOL_ID, args, ctx),
  async execute(args, ctx): Promise<SendOutput> {
    const chat = requireChatId(args.chat, MESSAGE_SEND_TOOL_ID)
    const text = checkedText(args.text)
    const paths = await pickPaths(ctx, args.account)
    const params: SendParams = {
      chat,
      text,
      ...(args.topic !== undefined && { topic: args.topic }),
      ...(args.reply_to !== undefined && { reply_to: args.reply_to }),
    }

    const startedAt = Date.now()
    try {
      const sent = await callService<SendResult>(paths.socket, SERVICE_REQUESTS.send, params, {
        effect: "write",
        signal: ctx.signal,
        timeoutMs: SEND_TIMEOUT_MS,
      })
      return sendResult(chat, sent)
    } catch (error) {
      throw isToolError(error) && error.code === "uncertain" ? withSentLike(error, paths, chat, text, startedAt) : error
    }
  },
})
