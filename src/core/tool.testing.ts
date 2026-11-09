import type { ToolContext } from "./tool"

/** Download settings for tests that do not save files. */
export const DOWNLOAD_CONTEXT = { downloadDir: "/downloads", downloadMaxMb: 100 } satisfies Pick<
  ToolContext,
  "downloadDir" | "downloadMaxMb"
>
