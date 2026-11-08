import { telegramAccountRead } from "./core/account/read"
import { telegramChatRead } from "./core/chat/read"
import { telegramSyncRead } from "./core/sync/read"
import type { ToolSpec } from "./core"

/** Every tool spec of the package; entry points register their tools from this list. */
export const ALL_TOOLS: ToolSpec[] = [telegramAccountRead, telegramChatRead, telegramSyncRead]
