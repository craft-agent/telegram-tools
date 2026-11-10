import { homedir } from "node:os"
import { ToolError } from "../../errors"
import { allowedRoots } from "../../outgoing/roots"
import { resolveOutgoing, type ResolvedOutgoing } from "../../outgoing/resolve"
import type { ToolContext } from "../../tool"
import { safeFileName } from "../names"

/** What names a file whose own name is unusable: `file-<position>`, the position counted from 1. */
const FALLBACK_KIND = "file"

/** A file the caller named, and where it really is. */
export type ResolvedFile = {
  /** The path as the caller gave it, quoted for a message. */
  shown: string
  /** The name the file is sent under: its own name made safe (`safeFileName`). */
  name: string
  /** The SHA-256 the caller approved, if one was given. */
  sha256: string | undefined
  resolved: ResolvedOutgoing
}

/**
 * Resolves every file a send names before any is read: each real path must be
 * in the working directory or a send directory and pass the rules of
 * `resolveOutgoing`, and no file may be named twice, by real path or by device
 * and inode alike (`invalid_argument`, naming the second path as given).
 * The state directory and the tools' own directory are never a source.
 */
export async function resolveFiles(
  files: readonly { path: string; sha256?: string }[],
  ctx: Pick<ToolContext, "cwd" | "sendDirs" | "stateDir" | "ownDir">,
): Promise<ResolvedFile[]> {
  const forbidden = [ctx.stateDir, ctx.ownDir].filter((directory): directory is string => directory !== undefined)
  const home = homedir()
  const roots = await allowedRoots({ cwd: ctx.cwd, sendDirs: ctx.sendDirs ?? [], home, forbidden })
  const seen = new Set<string>()
  const resolvedFiles: ResolvedFile[] = []
  for (const [position, { path, sha256 }] of files.entries()) {
    const shown = JSON.stringify(path)
    const resolved = await resolveOutgoing(path, { cwd: ctx.cwd, roots, forbidden, home })
    const keys = [`path:${resolved.realPath}`, `inode:${resolved.identity.dev}:${resolved.identity.ino}`]
    if (keys.some((key) => seen.has(key))) {
      throw new ToolError(
        "invalid_argument",
        `${shown} is the same file as an earlier one in files; name each file once.`,
      )
    }
    for (const key of keys) seen.add(key)
    const name = safeFileName(resolved.name, { kind: FALLBACK_KIND, id: position + 1, type: null })
    resolvedFiles.push({ shown, name, sha256, resolved })
  }
  return resolvedFiles
}
