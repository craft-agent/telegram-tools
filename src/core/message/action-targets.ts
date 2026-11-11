import { requireChatId } from "../chat/chat-rows"
import { pickPaths } from "../open"
import { ANY_TARGET } from "../targets"
import type { ToolContext } from "../tool"

/**
 * What an action on a whole chat writes to, as the permission rules name it:
 * `<label>/<chat>`, or `*` when the label or the chat cannot be told.
 */
export async function chatTargets(
  toolId: string,
  args: { account?: string; chat: string },
  ctx: Pick<ToolContext, "stateDir">,
): Promise<string[]> {
  try {
    const { label } = await pickPaths(ctx, args.account)
    return [`${label}/${requireChatId(args.chat, toolId)}`]
  } catch {
    return [ANY_TARGET]
  }
}

/**
 * What an action on a message writes to, as the permission rules name it:
 * `<label>/<chat>/<id>`, or `*` when the label or the chat cannot be told.
 */
export async function actionTargets(
  toolId: string,
  args: { account?: string; chat: string; id: number },
  ctx: Pick<ToolContext, "stateDir">,
): Promise<string[]> {
  try {
    const { label } = await pickPaths(ctx, args.account)
    return [`${label}/${requireChatId(args.chat, toolId)}/${args.id}`]
  } catch {
    return [ANY_TARGET]
  }
}
