import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { join } from "node:path"
import type { FileHandle } from "node:fs/promises"
import { ToolError } from "../../errors"
import { assertResolvedFile } from "../../outgoing/identity"
import type { ResolvedOutgoing } from "../../outgoing/resolve"
import { BYTES_PER_MB } from "../../telegram/service-requests"
import { copyAll, createNew, ensureDirectory, errorCode, openForRead } from "../fs-safe"
import type { ResolvedFile } from "./resolve-files"

/** The bytes a send may carry, shared by its files: what is copied so far, and the most there may be. */
export type ByteBudget = { used: number; limit: number }

/** A file copied into the outbox. */
export type Staged = {
  /** The private copy, which is what is checked and sent. */
  path: string
  /** The name the copy and the sent file carry. */
  name: string
  size: number
  sha256: string
}

/** A size for a message: whole megabytes as `100 MB`, anything else in bytes. */
function describeBytes(bytes: number): string {
  return bytes % BYTES_PER_MB === 0 ? `${bytes / BYTES_PER_MB} MB` : `${bytes} bytes`
}

/** Refuses, as `invalid_argument`, when `bytes` more would take the send past its limit; counts nothing. */
export function assertRoom(budget: ByteBudget, bytes: number): void {
  if (budget.used + bytes > budget.limit) {
    throw new ToolError(
      "invalid_argument",
      `The files together are over ${describeBytes(budget.limit)}, which is the most a send takes; send fewer or smaller files.`,
    )
  }
}

/** Counts `bytes` against the budget, refusing as `assertRoom` does when they take it past its limit. */
export function chargeBudget(budget: ByteBudget, bytes: number): void {
  budget.used += bytes
  assertRoom(budget, 0)
}

/** Refuses with `stale` when the caller gave a SHA-256 for the file and it is not `sha256`. */
export function assertApproved(shown: string, expected: string | undefined, sha256: string): void {
  if (expected !== undefined && expected.toLowerCase() !== sha256) {
    throw new ToolError("stale", `${shown} is not the file that was approved: its SHA-256 differs.`)
  }
}

/**
 * Opens the file that was resolved; a link or nothing at its real path any
 * more means it was swapped since. The open does not block, so a FIFO put in
 * its place fails the check on the descriptor at once instead of waiting for a
 * writer; a regular file reads as it always does.
 */
export async function openResolved(resolved: ResolvedOutgoing, shown: string): Promise<FileHandle> {
  try {
    return await openForRead(resolved.realPath, constants.O_NONBLOCK)
  } catch (error) {
    if (errorCode(error) === "ELOOP" || errorCode(error) === "ENOENT") {
      throw new ToolError("stale", `${shown} changed between being checked and being opened; try again.`)
    }
    throw error
  }
}

/**
 * Copies the file `file` stands for into `folder` (made here, 0700) under the
 * name it is sent under, as a new private file (0600): opened without
 * following a link, checked on that descriptor to be the file that was
 * resolved (`assertResolvedFile`) and read from that descriptor alone. The
 * copy's SHA-256 is taken as it is written and must match the one the caller
 * gave, when one was, else `stale`; the bytes count against `budget`, and a
 * file that takes it past its limit is `invalid_argument`.
 */
export async function stageFile(
  { shown, name, sha256: expected, resolved }: ResolvedFile,
  folder: string,
  budget: ByteBudget,
  signal?: AbortSignal,
): Promise<Staged> {
  const source = await openResolved(resolved, shown)
  try {
    assertResolvedFile(await source.stat({ bigint: true }), resolved.identity, shown)
    await ensureDirectory(folder)
    const path = join(folder, name)
    const target = await createNew(path)
    const hash = createHash("sha256")
    let size: number
    try {
      size = await copyAll(
        source,
        target,
        (chunk) => {
          chargeBudget(budget, chunk.length)
          hash.update(chunk)
        },
        signal,
      )
    } finally {
      await target.close()
    }
    const sha256 = hash.digest("hex")
    assertApproved(shown, expected, sha256)
    return { path, name, size, sha256 }
  } finally {
    await source.close()
  }
}
