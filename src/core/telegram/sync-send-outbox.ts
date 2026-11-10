import { constants } from "node:fs"
import { open, realpath, stat, type FileHandle } from "node:fs/promises"
import { isAbsolute, relative, sep } from "node:path"
import type { Readable } from "node:stream"
import { ToolError } from "../errors"
import { BYTES_PER_MB, SEND_FILES_MAX_BYTES, type SendFile } from "./service-requests"

/** How a file of a send is opened: for reading only, a link at its end refused, and never waiting on a pipe. */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

/** A file of a send that was checked and is held open; read it through `stream`, never by its path. */
export type OutboxFile = {
  name: string
  /** The bytes the file had when it was checked; the stream gives no more. */
  size: number
  /** A new stream of the file's bytes from the start, over the open descriptor. The caller destroys it. */
  stream(): Readable
}

function invalid(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

/** The error for a file that is no file of the outbox, whatever the reason; the path is never echoed. */
function notInOutbox(name: string): ToolError {
  return invalid(`${name} is not a file in the outbox; nothing was sent.`)
}

/** Whether `path` is a path below `dir` (both real): not `dir` itself and not outside it. */
function isInside(dir: string, path: string): boolean {
  const relation = relative(dir, path)
  return relation !== "" && relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)
}

/** A file opened for a send and checked against the outbox. */
type CheckedFile = { handle: FileHandle; size: number; identity: string }

/**
 * Opens one file of a send and checks what was opened, not what the path
 * names now: a regular file whose real path lies in the outbox, and that is
 * the very file the real path names (a path swapped in between is refused).
 * Closes the descriptor when any check fails.
 */
async function openChecked(realOutbox: string, { path, name }: SendFile): Promise<CheckedFile> {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, OPEN_FLAGS)
    const opened = await handle.stat({ bigint: true })
    const real = await realpath(path)
    const named = await stat(real, { bigint: true })
    const same = named.dev === opened.dev && named.ino === opened.ino
    if (!opened.isFile() || !same || !isInside(realOutbox, real)) throw new Error("not a file of the outbox")
    return { handle, size: Number(opened.size), identity: `${opened.dev}:${opened.ino}` }
  } catch {
    await handle?.close().catch(() => {})
    throw notInOutbox(name)
  }
}

/**
 * Opens the files of a send from `outbox` and runs `use` with them, closing
 * every descriptor when it settles. A file that is missing, is a link, is not
 * a regular file, or lies (by its real path) outside the outbox is
 * `invalid_argument`, and so are an empty file, the same file twice and files
 * over `SEND_FILES_MAX_BYTES` together: all before `use` runs.
 */
export async function withOutboxFiles<T>(
  outbox: string,
  files: readonly SendFile[],
  use: (opened: OutboxFile[]) => Promise<T>,
): Promise<T> {
  const handles: FileHandle[] = []
  try {
    const realOutbox = await realpath(outbox).catch(() => undefined)
    if (realOutbox === undefined) throw notInOutbox(files[0]?.name ?? "The file")
    const opened: OutboxFile[] = []
    const identities = new Set<string>()
    let total = 0
    for (const file of files) {
      const { handle, size, identity } = await openChecked(realOutbox, file)
      handles.push(handle)
      if (identities.has(identity)) throw invalid(`${file.name} is the same file as another one; nothing was sent.`)
      identities.add(identity)
      if (size === 0) throw invalid(`${file.name} is empty; nothing was sent.`)
      total += size
      if (total > SEND_FILES_MAX_BYTES) {
        throw invalid(`The files are over ${SEND_FILES_MAX_BYTES / BYTES_PER_MB} MB together; nothing was sent.`)
      }
      opened.push({
        name: file.name,
        size,
        stream: () => handle.createReadStream({ start: 0, end: size - 1, autoClose: false }),
      })
    }
    return await use(opened)
  } finally {
    await Promise.all(handles.map((handle) => handle.close().catch(() => {})))
  }
}
