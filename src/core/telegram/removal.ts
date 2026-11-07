import { lstat, rm } from "node:fs/promises"
import { ToolError } from "../errors"
import { isWithin } from "../paths"
import { checkLabel, labelPaths, listLabels } from "./labels"
import { acquireSyncLock, lockHolder } from "./sync-lock"

/** How long removal waits for a running sync service to exit. */
const DEFAULT_POLL_TIMEOUT_MS = 5_000

/** How often removal checks whether the sync service is still running. */
const DEFAULT_POLL_INTERVAL_MS = 100

export type RemoveLabelOptions = {
  /** The state directory containing label state subdirectories. */
  stateDir: string
  /** The account label to remove. */
  label: string
  /** Callback to stop and uninstall the service definition before removal. */
  uninstall: () => Promise<void>
  /** Maximum time in ms to wait for the sync service to exit. Defaults to 5000 ms. */
  pollTimeoutMs?: number
  /** Interval in ms between checks for the sync service. Defaults to 100 ms. */
  pollIntervalMs?: number
}

/**
 * Permanently removes a label and its entire state directory.
 *
 * Checks that the label exists and is not a symlink, uninstalls the service,
 * waits for a running sync service (a live process other than this one named
 * by `sync.lock`) to stop, and recursively deletes the label directory.
 */
export async function removeLabel(options: RemoveLabelOptions): Promise<void> {
  const { stateDir, label, uninstall } = options
  checkLabel(label)

  const paths = labelPaths(stateDir, label)

  const initialStat = await lstat(paths.dir).catch(() => undefined)
  if (initialStat && (initialStat.isSymbolicLink() || !initialStat.isDirectory())) {
    throw new ToolError("invalid_argument", `Label directory "${paths.dir}" is not a directory.`)
  }

  const labels = await listLabels(stateDir)
  if (!labels.includes(label)) {
    const known = labels.length > 0 ? `known accounts: ${labels.join(", ")}.` : "no Telegram account is logged in yet."
    throw new ToolError("not_found", `Telegram account "${label}" was not found; ${known}`)
  }

  await uninstall()

  const timeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
  const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const start = Date.now()

  while (lockHolder(paths.syncLock) !== undefined) {
    if (Date.now() - start >= timeoutMs) {
      throw new ToolError("invalid_argument", "The sync service for this label is still running; stop it first.")
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, timeoutMs - (Date.now() - start))))
  }

  const finalStat = await lstat(paths.dir).catch(() => undefined)
  if (!finalStat || finalStat.isSymbolicLink() || !finalStat.isDirectory()) {
    throw new ToolError("invalid_argument", `Label directory "${paths.dir}" is not a directory.`)
  }

  if (!(await isWithin(paths.dir, stateDir))) {
    throw new ToolError("invalid_argument", `Label directory "${paths.dir}" is not inside state directory.`)
  }

  // The lock stays held while the directory is deleted; it goes with the directory.
  const release = acquireSyncLock(paths.syncLock)
  if (release === undefined) {
    throw new ToolError("invalid_argument", "The sync service for this label is still running; stop it first.")
  }
  try {
    await rm(paths.dir, { recursive: true, force: true })
  } finally {
    release()
  }
}
