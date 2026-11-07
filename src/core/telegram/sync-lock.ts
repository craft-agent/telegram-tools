import { closeSync, linkSync, openSync, readFileSync, rmSync, writeSync } from "node:fs"

/** Owner read and write only, like the rest of the label's state. */
const LOCK_MODE = 0o600

/** Why a run does not start when another holds the label's lock. */
export const LOCK_HELD_REASON = "another sync service is already running for this account"

function isEexist(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST"
}

/** The process id a lock file names, or undefined when there is no file or it holds no process id. */
function readPid(path: string): number | undefined {
  try {
    const pid = Number(readFileSync(path, "utf8").trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

/** Whether a process with this id exists (also when it belongs to someone else). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** The id of the live process, other than this one, that the lock file names; undefined when there is none. */
export function lockHolder(path: string): number | undefined {
  const holder = readPid(path)
  return holder !== undefined && holder !== process.pid && isAlive(holder) ? holder : undefined
}

/**
 * Creates the lock file complete: this process's id is written to a temporary file beside it, which is
 * linked to the lock path (failing with EEXIST while a lock exists) and then removed, so a reader never
 * sees an empty or partial lock.
 */
function publishLock(path: string): void {
  const temp = `${path}.${process.pid}.tmp`
  rmSync(temp, { force: true })
  const fd = openSync(temp, "wx", LOCK_MODE)
  try {
    try {
      writeSync(fd, `${process.pid}\n`)
    } finally {
      closeSync(fd)
    }
    linkSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}

/**
 * Takes the exclusive lock of a label's sync service: a file holding this
 * process's id, published whole only if no lock exists. A lock whose process is
 * gone (or whose content is unreadable) is taken over.
 *
 * Returns the function that releases the lock, which removes the file only
 * while it still names this process, or undefined when another live process
 * holds it.
 */
export function acquireSyncLock(path: string): (() => void) | undefined {
  // Two tries: the second follows the removal of a lock nobody holds, and loses only to a run that took it first.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      publishLock(path)
      return () => {
        if (readPid(path) === process.pid) rmSync(path, { force: true })
      }
    } catch (error) {
      if (!isEexist(error)) throw error
    }
    if (lockHolder(path) !== undefined) return undefined
    rmSync(path, { force: true })
  }
  return undefined
}
