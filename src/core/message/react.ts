import { requireChatId } from "../chat/chat-rows"
import { pickPaths, readMirror } from "../open"
import { cut, MAX_VALUE_LENGTH } from "../describe"
import { ownReaction } from "../telegram/action-checks"
import { callService } from "../telegram/service"
import { REACTION_MAX_UNITS, type ReactParams, type ReactResult, SERVICE_REQUESTS } from "../telegram/service-requests"
import { defineTool } from "../tool"
import { describeAction, REACT_HEADLINES, UNREACT_HEADLINES } from "./action-describe"
import { reactInput, reactOutput, type ReactOutput } from "./action-schema"
import { actionTargets } from "./action-targets"
import { checkedReaction } from "./arguments"
import { ACTION_TIMEOUT_MS, MESSAGE_REACT_TOOL_ID } from "./constants"
import { findAnyMessage } from "./own"
import { reactResult } from "./result"

/** The `telegram_message_react` tool definition. */
export const telegramMessageReact = defineTool({
  id: MESSAGE_REACT_TOOL_ID,
  title: "Set or remove a reaction",
  description: [
    "Reacts to a message with one standard emoji as the user, or removes the user's own reaction from it. The reaction replaces any earlier one of the user's on that message.",
    "`chat` is a chat id from `telegram_chat_read`, never a name, username or phone number; `id` is the message's id from `telegram_chat_read`, and may be anyone's message, not only the user's own.",
    `Give exactly one of \`emoji\` (one standard emoji of at most ${REACTION_MAX_UNITS} characters, with no letters, digits or blank space) and \`remove\` (\`true\`). Custom emoji reactions need Premium and paid reactions spend Stars, so both are refused; which emoji a chat allows is Telegram's to decide.`,
    "It is refused for a message not in the mirror or already deleted, and for a chat the user has left.",
    "Needs the sync service running, and the `actions` toolset, which is off by default.",
    "A result means Telegram accepted the reaction, and `emoji` is the user's reaction now (`removed` when it was taken away). `already` means it was already so, so nothing changed.",
    "A failure `uncertain` means the reaction may have gone through: check the chat in Telegram and never ask for it again without the user checking.",
  ].join(" "),
  intent: "About to change a reaction",
  toolset: "actions",
  class: "overwrite",
  input: reactInput,
  output: reactOutput,
  async describe(args, ctx) {
    const emoji = checkedReaction(args.emoji, args.remove)
    const chat = requireChatId(args.chat, MESSAGE_REACT_TOOL_ID)
    const paths = await pickPaths(ctx, args.account)
    const target = readMirror(paths, (mirror) => findAnyMessage(mirror, chat, args.id, "react"))
    const own = ownReaction(target.message.reactions)
    return describeAction(
      emoji === undefined ? UNREACT_HEADLINES : REACT_HEADLINES,
      target.chat,
      args.id,
      target.message,
      {
        ...(emoji !== undefined && { values: { emoji } }),
        ...(own !== undefined &&
          own !== emoji && { facts: [{ label: "Replaces", value: cut(own, MAX_VALUE_LENGTH) }] }),
        pins: { reaction: own ?? "" },
      },
    )
  },
  targets: (args, ctx) => actionTargets(MESSAGE_REACT_TOOL_ID, args, ctx),
  async execute(args, ctx): Promise<ReactOutput> {
    const emoji = checkedReaction(args.emoji, args.remove)
    const chat = requireChatId(args.chat, MESSAGE_REACT_TOOL_ID)
    const paths = await pickPaths(ctx, args.account)
    readMirror(paths, (mirror) => findAnyMessage(mirror, chat, args.id, "react"))

    const params: ReactParams = emoji === undefined ? { chat, id: args.id, remove: true } : { chat, id: args.id, emoji }
    const reacted = await callService<ReactResult>(paths.socket, SERVICE_REQUESTS.react, params, {
      effect: "write",
      signal: ctx.signal,
      timeoutMs: ACTION_TIMEOUT_MS,
    })
    return reactResult(chat, reacted)
  },
})
