import { DOWNLOAD_CONTEXT } from "../tool.testing"
import type { ToolContext } from "../tool"

/** A tool context over `stateDir` whose `exclude_chats` setting holds `chats`. */
export function excludingContext(stateDir: string, chats: readonly string[]): ToolContext {
  return { cwd: stateDir, stateDir, ...DOWNLOAD_CONTEXT, options: { exclude_chats: [...chats] } }
}
