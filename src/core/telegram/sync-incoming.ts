import { randomBytes } from "node:crypto"
import { chmod, lstat, mkdir, readdir, rm } from "node:fs/promises"
import { join } from "node:path"

/** The permissions of `incoming/`, of the folder of each download and of the folders of kept files: the owner only. */
export const FOLDER_MODE = 0o700

/** How many random bytes name a download's folder. */
const FOLDER_NAME_BYTES = 16

/** The name of every downloaded file inside its folder; the sender's name never reaches the file system. */
export const DOWNLOADED_FILE_NAME = "file"

/** A download's folder under `incoming/`, and the file in it that the bytes go to. */
export type DownloadFolder = { dir: string; file: string }

/**
 * Empties `incoming` of what a service that was killed left, at start. Each
 * entry is removed itself: a link goes, and what it points to stays. A path
 * that is not a real directory (a link, a file) is removed too; it is made
 * again when the first download needs it. A download removes its own folder
 * when it fails, but the service does not wait for that when it stops, so a
 * folder can outlive a stop; this sweep at the next start is what covers it.
 */
export async function clearIncoming(incoming: string): Promise<void> {
  const entry = await lstat(incoming).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!entry) return
  if (!entry.isDirectory()) {
    await rm(incoming, { force: true })
    return
  }
  for (const name of await readdir(incoming)) await rm(join(incoming, name), { recursive: true, force: true })
}

/**
 * Makes a folder for one download, with a random name, mode 700, under
 * `incoming`, which is created with mode 700 when it is missing. The name is
 * taken exclusively: one that exists already fails.
 */
export async function createDownloadFolder(incoming: string): Promise<DownloadFolder> {
  await mkdir(incoming, { recursive: true, mode: FOLDER_MODE })
  await chmod(incoming, FOLDER_MODE)
  const dir = join(incoming, randomBytes(FOLDER_NAME_BYTES).toString("hex"))
  await mkdir(dir, { mode: FOLDER_MODE })
  await chmod(dir, FOLDER_MODE)
  return { dir, file: join(dir, DOWNLOADED_FILE_NAME) }
}

/** Removes a download's folder with whatever is in it; one that is gone is not an error. */
export function discardFolder(dir: string): Promise<void> {
  return rm(dir, { recursive: true, force: true })
}
