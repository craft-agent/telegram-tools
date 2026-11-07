import { chatInputOfDialog } from "./from-mtcute"
import { inTransaction, setMeta } from "./mirror"
import { META } from "./mirror-meta"
import type { ChatInput } from "./mirror-input"
import { writing } from "./sync-ending"
import { failedCall, fillGaps, type BackgroundContext } from "./sync-fetch"
import { keepsKind, rememberChats } from "./sync-follow"

/** Reads the whole chat list, archived chats included, as inputs; chats the mirror does not keep are left out. */
async function readDialogs(ctx: BackgroundContext): Promise<ChatInput[]> {
  const { client, settings, signal } = ctx
  const dialogs: ChatInput[] = []
  for await (const dialog of client.iterDialogs({ archived: "keep" })) {
    if (signal.aborted) break
    try {
      const input = chatInputOfDialog(dialog)
      if (input && keepsKind(input.kind, settings.channels)) dialogs.push(input)
    } catch {
      // One dialog mtcute cannot read does not cost the list.
    }
  }
  return dialogs
}

/**
 * Reads the chat list into the mirror, with the time, then fills the gaps in
 * the followed chats. Returns false when the list could not be read (handled
 * and left for a later round); a session that ended or a mirror that cannot
 * be written throws.
 */
export async function refreshChats(ctx: BackgroundContext): Promise<boolean> {
  const { mirror, settings, signal } = ctx
  let dialogs: ChatInput[]
  try {
    dialogs = await readDialogs(ctx)
  } catch (error) {
    await failedCall(ctx, error, "chat list refresh")
    return false
  }
  if (signal.aborted) return false
  const now = settings.now()
  writing(() =>
    inTransaction(mirror, () => {
      rememberChats(mirror, dialogs, now, settings.channels)
      setMeta(mirror, { [META.refreshedAt]: now })
    }),
  )
  const filled = await fillGaps(ctx, dialogs)
  settings.log(`refreshed ${dialogs.length} chats, filled ${filled} messages`)
  return true
}
