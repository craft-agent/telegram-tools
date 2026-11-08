import { realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative } from "node:path"
import { ToolError } from "../errors"
import type { ToolContext } from "../tool"
import { ensureDirectory, errorCode, NotAFolder } from "./fs-safe"

/** What a call needs of its context to know where files go. */
export type FolderContext = Pick<ToolContext, "downloadDir" | "stateDir" | "ownDir">

/** The folder of one message under the download directory, as the names of its parts. */
export type MessageFolder = { label: string; chat: string; id: string }

/** A path as far as it exists (by real path, links resolved) and the components below that which do not exist yet. */
type PlannedPath = { existing: string; missing: string[] }

const MISSING = new Set(["ENOENT", "ENOTDIR"])

/** Resolves the nearest existing ancestor of `path` by real path, and lists what has still to be made below it. */
async function plan(path: string): Promise<PlannedPath> {
  const missing: string[] = []
  for (let current = path; ;) {
    try {
      return { existing: await realpath(current), missing: missing.reverse() }
    } catch (error) {
      const parent = dirname(current)
      if (!MISSING.has(errorCode(error) ?? "") || parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}

function planned({ existing, missing }: PlannedPath): string {
  return join(existing, ...missing)
}

/** Whether `path` is `root` or inside it; both are real paths. */
export function isInside(path: string, root: string): boolean {
  const from = relative(root, path)
  return from === "" || !(from === ".." || from.startsWith("../") || from.startsWith("..\\") || isAbsolute(from))
}

/** The folders a download folder may not be in or under, by what they are called in the refusal. */
function forbiddenRoots(ctx: FolderContext): Array<[root: string, what: string]> {
  const roots: Array<[string, string]> = []
  if (ctx.stateDir) roots.push([ctx.stateDir, "state directory"])
  if (ctx.ownDir) roots.push([ctx.ownDir, "directory these tools are installed in"])
  return roots
}

/** The refusal for a download folder that cannot be made or written to. */
function unusable(error: unknown): ToolError {
  if (error instanceof NotAFolder) {
    return new ToolError("invalid_argument", `${error.message} Remove it or change the download_dir setting.`, {
      cause: error,
    })
  }
  return new ToolError(
    "invalid_argument",
    `The download folder could not be made or written to (${errorCode(error) ?? "error"}); check the download_dir setting.`,
    { cause: error },
  )
}

/**
 * Checks, without writing anything, that the download directory and the
 * folder this message goes in are fit to save into: the setting is there, and
 * their real paths (the nearest existing ancestor with the rest below it)
 * are neither the state directory nor the tools' own directory nor inside
 * one. `invalid_argument` names the `download_dir` setting; an entry point
 * that supplied no download directory is `internal_error`. Resolves to the
 * download directory.
 */
export async function checkDownloadDir(ctx: FolderContext, folder: MessageFolder): Promise<string> {
  const { downloadDir } = ctx
  if (!downloadDir) throw new ToolError("internal_error", "The entry point did not supply a download directory.")
  if (!isAbsolute(downloadDir)) {
    throw new ToolError(
      "internal_error",
      `The download directory must be absolute; got ${JSON.stringify(downloadDir)}.`,
    )
  }
  let target: string
  try {
    target = planned(await plan(join(downloadDir, folder.label, folder.chat, folder.id)))
  } catch (error) {
    throw unusable(error)
  }
  for (const [root, what] of forbiddenRoots(ctx)) {
    const real = planned(await plan(root).catch(() => ({ existing: root, missing: [] })))
    if (isInside(target, real)) {
      throw new ToolError(
        "invalid_argument",
        `The download_dir setting puts files inside the ${what}; choose a folder of your own for received files.`,
      )
    }
  }
  return downloadDir
}

/**
 * Makes the download directory, the label's folder, the chat's folder and the
 * message's folder (0700), component by component and each checked with `lstat`, and returns
 * the message folder's real path. A link or a file where a folder belongs is
 * `invalid_argument`; nothing below the download directory is followed.
 */
export async function openMessageFolder(downloadDir: string, folder: MessageFolder): Promise<string> {
  try {
    const { existing, missing } = await plan(downloadDir)
    let current = existing
    for (const component of [...missing, folder.label, folder.chat, folder.id]) {
      current = join(current, component)
      await ensureDirectory(current)
    }
    return current
  } catch (error) {
    throw unusable(error)
  }
}
