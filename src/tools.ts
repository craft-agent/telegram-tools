import { telegramAccountRead } from "./core/account/read"
import { telegramChatRead } from "./core/chat/read"
import { telegramFileSave } from "./core/file/save"
import { telegramSyncAdd } from "./core/sync/add"
import { telegramSyncRead } from "./core/sync/read"
import { telegramSyncRemove } from "./core/sync/remove"
import type { ToolSpec } from "./core"

/** Every tool spec of the package; entry points register their tools from this list. */
export const ALL_TOOLS: ToolSpec[] = [
  telegramAccountRead,
  telegramChatRead,
  telegramFileSave,
  telegramSyncRead,
  telegramSyncAdd,
  telegramSyncRemove,
]
