import { chmodSync, closeSync, openSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { ToolError } from "../errors"
import { MIGRATIONS, MIRROR_VERSION } from "./mirror-schema"

/** One label's mirror: a SQLite database in WAL mode. */
export type Mirror = DatabaseSync

/** How long a statement waits for the other connection's lock, in milliseconds. */
const BUSY_TIMEOUT_MS = 10_000

/** Owner read and write only: the mirror holds every message the account received. */
const FILE_MODE = 0o600

const NOT_SYNCED = "Nothing has been received for this account yet: its sync service has not run."
const TOO_NEW = "This mirror was written by a newer version of these tools; update them."
const TOO_OLD =
  "This mirror is from an older version of these tools; restart the account's sync service to bring it up to date."

function schemaVersion(mirror: Mirror): number {
  const row = mirror.prepare("PRAGMA user_version").get() as { user_version: number }
  return row.user_version
}

function setBusyTimeout(mirror: Mirror): void {
  mirror.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
}

/** Creates the file when missing and makes it 0600 either way, before SQLite opens it, so the umask cannot widen it. */
function secureFile(path: string): void {
  closeSync(openSync(path, "a", FILE_MODE))
  chmodSync(path, FILE_MODE)
}

function openDatabase(path: string, read: boolean): Mirror {
  try {
    if (read) closeSync(openSync(path, "r"))
    else secureFile(path)
    return new DatabaseSync(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (read && code === "ENOENT") throw new ToolError("not_found", NOT_SYNCED)
    const suffix = typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : ""
    throw new ToolError("upstream_error", `The mirror could not be opened${suffix}.`)
  }
}

/** Applies `MIGRATIONS` from the mirror's version to `MIRROR_VERSION` in one transaction. */
function migrate(mirror: Mirror): void {
  inTransaction(mirror, () => {
    const version = schemaVersion(mirror)
    if (version > MIRROR_VERSION) throw new ToolError("upstream_error", TOO_NEW)
    for (const migration of MIGRATIONS.slice(version)) mirror.exec(migration)
    if (version < MIRROR_VERSION) mirror.exec(`PRAGMA user_version = ${MIRROR_VERSION}`)
  })
}

/**
 * Opens the mirror for the sync service, the only writer: creates the file
 * (0600) when missing and brings its schema up to date. A mirror written by a
 * newer version is refused (`upstream_error`) and left untouched.
 */
export function openMirrorForWrite(path: string): Mirror {
  const mirror = openDatabase(path, false)
  try {
    setBusyTimeout(mirror)
    if (schemaVersion(mirror) > MIRROR_VERSION) throw new ToolError("upstream_error", TOO_NEW)
    mirror.exec("PRAGMA journal_mode = WAL")
    migrate(mirror)
    return mirror
  } catch (error) {
    mirror.close()
    throw error
  }
}

/**
 * Opens the mirror for a tool: it never creates, migrates or writes anything.
 * A mirror that does not exist or was never set up is `not_found`; one of
 * another version is `upstream_error`.
 *
 * The connection is read-write with `query_only` on, not SQLite's read-only
 * mode: a WAL database cannot be opened read-only once its `-shm` file is
 * gone, which is the normal state of a mirror whose sync service stopped.
 */
export function openMirrorForRead(path: string): Mirror {
  const mirror = openDatabase(path, true)
  try {
    setBusyTimeout(mirror)
    mirror.exec("PRAGMA query_only = ON")
    const version = schemaVersion(mirror)
    if (version === 0) throw new ToolError("not_found", NOT_SYNCED)
    if (version > MIRROR_VERSION) throw new ToolError("upstream_error", TOO_NEW)
    if (version < MIRROR_VERSION) throw new ToolError("upstream_error", TOO_OLD)
    return mirror
  } catch (error) {
    mirror.close()
    throw error
  }
}

/** Runs `fn` in one write transaction: committed when it returns, rolled back when it throws. */
export function inTransaction<T>(mirror: Mirror, fn: () => T): T {
  mirror.exec("BEGIN IMMEDIATE")
  try {
    const result = fn()
    mirror.exec("COMMIT")
    return result
  } catch (error) {
    if (mirror.isTransaction) mirror.exec("ROLLBACK")
    throw error
  }
}

/** Every key the mirror holds in `meta`. */
export function getMeta(mirror: Mirror): Record<string, string> {
  const rows = mirror.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[]
  return Object.fromEntries(rows.map((row) => [row.key, row.value]))
}

/** Sets each key to its value as text; a `null` removes the key. */
export function setMeta(mirror: Mirror, values: Record<string, string | number | null>): void {
  const set = mirror.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
  const remove = mirror.prepare("DELETE FROM meta WHERE key = ?")
  for (const [key, value] of Object.entries(values)) {
    if (value === null) remove.run(key)
    else set.run(key, String(value))
  }
}
