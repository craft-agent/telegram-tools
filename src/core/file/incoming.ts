import { lstat, realpath, type FileHandle } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import { ToolError } from "../errors"
import { openForRead } from "./fs-safe"
import { discard } from "./place"

const NOT_A_DOWNLOAD =
  "The sync service named a downloaded file that is not a plain file in a folder of the label's incoming folder."

/** A downloaded file opened for reading, and the real path of the folder it is in. */
export type Downloaded = { handle: FileHandle; folder: string }

/**
 * Opens the file the service says it downloaded, but only when it really is
 * one: a regular file, not a link, that resolves to a place directly inside a
 * download folder of `incoming`. Anything else is `internal_error`, and
 * nothing is opened.
 */
export async function openDownloaded(incoming: string, path: string): Promise<Downloaded> {
  const refused = (cause?: unknown) => new ToolError("internal_error", NOT_A_DOWNLOAD, { cause })
  if (!isAbsolute(path)) throw refused()
  let real: string
  let root: string
  let found: Awaited<ReturnType<typeof lstat>>
  try {
    ;[real, root] = await Promise.all([realpath(path), realpath(incoming)])
    found = await lstat(path)
  } catch (error) {
    throw refused(error)
  }
  const folder = dirname(real)
  if (!found.isFile() || dirname(folder) !== root) throw refused()

  const handle = await openForRead(path).catch((error: unknown) => {
    throw refused(error)
  })
  const opened = await handle.stat().catch(() => undefined)
  if (!opened?.isFile() || opened.dev !== found.dev || opened.ino !== found.ino) {
    await handle.close().catch(() => {})
    throw refused()
  }
  return { handle, folder }
}

/**
 * Removes the download folder the service named: the parent of `path`, and
 * only when that is a direct child of `incoming`. A path anywhere else, or a
 * folder that cannot be removed, is left alone; the service sweeps `incoming`
 * when it starts.
 */
export async function discardDownload(incoming: string, path: string): Promise<void> {
  if (!isAbsolute(path)) return
  const folder = dirname(resolve(path))
  if (dirname(folder) !== incoming) return
  await discard(folder).catch(() => {})
}
