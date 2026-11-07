import { access, rm } from "node:fs/promises"
import { ToolError } from "../errors"
import type { LabelPaths } from "./labels"
import { acquireSyncLock } from "./sync-lock"

/** The part of a Telegram client that logging out uses. */
export type LogoutClient = {
  /** Ends the session at Telegram. */
  logOut(): Promise<unknown>
  /** Closes the connection and the storage. */
  destroy(): Promise<void>
}

export type LogoutLabelOptions = {
  /** Where the label keeps its state. */
  paths: LabelPaths
  /** Opens a client on the label's session. */
  openClient: () => Promise<LogoutClient>
}

/** The files SQLite keeps beside the session database. */
const SESSION_FILE_SUFFIXES = ["", "-wal", "-shm"]

/** Removes the session database and the files SQLite keeps beside it; missing files are ignored. */
export async function removeSessionFiles(session: string): Promise<void> {
  for (const suffix of SESSION_FILE_SUFFIXES) {
    await rm(`${session}${suffix}`, { force: true })
  }
}

/**
 * Logs a label out: ends the session at Telegram, then removes the session
 * storage. The app's credentials (`app.json`) and the mirror are kept.
 *
 * Refuses (`invalid_argument`) while a sync service holds the label, since a
 * second connection can end the session, and throws `not_found` when the
 * label has no session. When Telegram cannot be reached or has already ended
 * the session, the session storage is removed anyway and `endedAtTelegram`
 * is false; the caller tells the person to end the session under
 * Settings → Devices. An error's text is never put in a message.
 */
export async function logoutLabel(options: LogoutLabelOptions): Promise<{ endedAtTelegram: boolean }> {
  const { paths, openClient } = options

  const release = acquireSyncLock(paths.syncLock)
  if (release === undefined) {
    throw new ToolError("invalid_argument", "The sync service for this label is running; stop it first.")
  }
  try {
    if (
      !(await access(paths.session).then(
        () => true,
        () => false,
      ))
    ) {
      throw new ToolError("not_found", "This account is not logged in.")
    }

    let endedAtTelegram = false
    try {
      const client = await openClient()
      try {
        await client.logOut()
        endedAtTelegram = true
      } finally {
        await client.destroy().catch(() => {})
      }
    } catch {
      // Network failures and ended sessions leave the session unended at Telegram; the caller reports that.
    }

    await removeSessionFiles(paths.session)
    return { endedAtTelegram }
  } finally {
    release()
  }
}
