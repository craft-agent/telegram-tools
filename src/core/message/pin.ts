import { requireChatId } from "../chat/chat-rows"
import { pickPaths, readMirror } from "../open"
import { isPrivateChat } from "../telegram/action-checks"
import { callService } from "../telegram/service"
import { type PinParams, type PinResult, SERVICE_REQUESTS } from "../telegram/service-requests"
import { type CallFact, defineTool } from "../tool"
import { describeAction, PIN_HEADLINES, UNPIN_HEADLINES } from "./action-describe"
import { pinInput, pinOutput, type PinOutput } from "./action-schema"
import { actionTargets } from "./action-targets"
import { checkedPinFlags, type PinFlags } from "./arguments"
import { ACTION_TIMEOUT_MS, MESSAGE_PIN_TOOL_ID } from "./constants"
import { preparePin } from "./pin-prepare"
import { pinResult } from "./result"

/** The facts a pin adds when it tells the members (`Notify`) and when it pins for the other person too (`Both sides`). */
function pinFacts({ notify, both_sides }: PinFlags): CallFact[] {
  return [
    ...(notify ? [{ label: "Notify", value: { text: "Yes" } }] : []),
    ...(both_sides ? [{ label: "Both sides", value: { text: "Yes" } }] : []),
  ]
}

/** The `pin` request for the call: a flag that is off is left out, as the service reads it. */
function pinParams(chat: string, args: { id: number } & PinFlags): PinParams {
  return {
    chat,
    id: args.id,
    ...(args.unpin ? { unpin: true } : {}),
    ...(args.notify ? { notify: true } : {}),
    ...(args.both_sides ? { both_sides: true } : {}),
  }
}

/** The `telegram_message_pin` tool definition. */
export const telegramMessagePin = defineTool({
  id: MESSAGE_PIN_TOOL_ID,
  title: "Pin or unpin a message",
  description: [
    "Pins a message in a chat, or unpins it (`unpin`). The message may be anyone's, not only the user's own.",
    "`chat` is a chat id from `telegram_chat_read`, never a name, username or phone number; `id` is the message's id from `telegram_chat_read`.",
    "A pin is silent by default: pinning in a group tells the members only with `notify`. In a chat with a person or a bot it pins for the user only by default; `both_sides` pins for the other person too, which only such a chat has. `notify` and `both_sides` go with a pin, not an unpin.",
    "It is refused for a message not in the mirror or already deleted, and for a chat the user has left.",
    "Needs the sync service running, and the `actions` toolset, which is off by default. Whether a message is pinned is not kept in the mirror, so `telegram_chat_read` does not show it.",
    "A result means Telegram pinned or unpinned the message (`pinned` says which). `already` means it was already so, so nothing changed.",
    "A failure `uncertain` means the pin may have gone through: check the chat in Telegram and never ask for it again without the user checking.",
  ].join(" "),
  intent: "About to pin or unpin a message",
  toolset: "actions",
  class: "overwrite",
  input: pinInput,
  output: pinOutput,
  async describe(args, ctx) {
    checkedPinFlags(args)
    const chat = requireChatId(args.chat, MESSAGE_PIN_TOOL_ID)
    const paths = await pickPaths(ctx, args.account)
    const target = readMirror(paths, (mirror) => preparePin(mirror, chat, args.id, args))
    return describeAction(args.unpin ? UNPIN_HEADLINES : PIN_HEADLINES, target.chat, args.id, target.message, {
      facts: pinFacts(args),
    })
  },
  targets: (args, ctx) => actionTargets(MESSAGE_PIN_TOOL_ID, args, ctx),
  async execute(args, ctx): Promise<PinOutput> {
    checkedPinFlags(args)
    const chat = requireChatId(args.chat, MESSAGE_PIN_TOOL_ID)
    const paths = await pickPaths(ctx, args.account)
    const { chat: row } = readMirror(paths, (mirror) => preparePin(mirror, chat, args.id, args))

    const pinned = await callService<PinResult>(paths.socket, SERVICE_REQUESTS.pin, pinParams(chat, args), {
      effect: "write",
      signal: ctx.signal,
      timeoutMs: ACTION_TIMEOUT_MS,
    })
    return pinResult(chat, pinned, {
      notify: args.notify === true,
      oneSided: isPrivateChat(row.kind) && args.both_sides !== true,
    })
  },
})
