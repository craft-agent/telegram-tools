import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { isToolError } from "../errors"
import { getMeta, inTransaction, openMirrorForRead, openMirrorForWrite, setMeta, type Mirror } from "./mirror"
import { MIGRATIONS, MIRROR_VERSION } from "./mirror-schema"
import { PER_CHAT_KINDS_SQL } from "./mirror-rows"
import { columnOf, errorOf, makeTempDir, rowsOf } from "./mirror.testing"

let dir: string
let path: string
const opened: Mirror[] = []

function tracked(mirror: Mirror): Mirror {
  opened.push(mirror)
  return mirror
}

function version(mirror: Mirror): unknown {
  return columnOf(mirror, "PRAGMA user_version")[0]
}

/** A file that a newer version of these tools wrote. */
function writeNewerMirror(): void {
  const raw = new DatabaseSync(path)
  raw.exec("CREATE TABLE future (x); PRAGMA user_version = 99")
  raw.close()
}

beforeEach(() => {
  dir = makeTempDir()
  path = join(dir, "mirror.sqlite")
})

afterEach(() => {
  for (const mirror of opened.splice(0)) if (mirror.isOpen) mirror.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("openMirrorForWrite", () => {
  test("hides the path when the parent directory is missing", () => {
    const missing = join(dir, "missing", "mirror.sqlite")
    const error = errorOf(() => openMirrorForWrite(missing))
    expect(isToolError(error) && error.code).toBe("upstream_error")
    expect(error.message).toContain("(ENOENT)")
    expect(error.message).not.toContain(dir)
    expect(error.message).not.toContain(missing)
  })

  test("creates the file with mode 0600, whatever the umask", () => {
    const old = process.umask(0)
    try {
      tracked(openMirrorForWrite(path))
    } finally {
      process.umask(old)
    }
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test("narrows an existing file to 0600", () => {
    tracked(openMirrorForWrite(path)).close()
    chmodSync(path, 0o644)
    tracked(openMirrorForWrite(path))
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test("uses WAL and creates the current schema from nothing", () => {
    const mirror = tracked(openMirrorForWrite(path))
    expect(columnOf(mirror, "PRAGMA journal_mode")).toEqual(["wal"])
    expect(version(mirror)).toBe(MIRROR_VERSION)
    expect(MIGRATIONS).toHaveLength(MIRROR_VERSION)
    const tables = columnOf(mirror, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    expect(tables).toEqual(["chats", "deleted", "edits", "gaps", "messages", "meta", "topics"])
  })

  test("looks up chatless deletes through the message-id index", () => {
    const mirror = tracked(openMirrorForWrite(path))
    const plan = rowsOf(
      mirror,
      `EXPLAIN QUERY PLAN
      SELECT m.chat, m.expires FROM messages m JOIN chats c ON c.id = m.chat
      WHERE m.id = ? AND c.kind NOT IN (${PER_CHAT_KINDS_SQL})`,
      1,
    )
    expect(plan.some((row) => String(row.detail).includes("USING INDEX messages_id"))).toBe(true)
    expect(plan.some((row) => String(row.detail).includes("SCAN m"))).toBe(false)
  })

  test("takes an empty file as a new mirror and keeps its data when opened again", () => {
    writeFileSync(path, "")
    const first = tracked(openMirrorForWrite(path))
    setMeta(first, { kept: "yes" })
    first.close()
    const second = tracked(openMirrorForWrite(path))
    expect(getMeta(second)).toEqual({ kept: "yes" })
    expect(version(second)).toBe(MIRROR_VERSION)
  })

  test("migrates a mirror of version 1 to the current one, which only a writer does, keeping its messages", () => {
    const raw = new DatabaseSync(path)
    raw.exec(MIGRATIONS[0]!)
    raw.exec("INSERT INTO chats (id, kind, updated) VALUES ('1', 'user', 0)")
    raw.exec("INSERT INTO messages (chat, id, ts, received) VALUES ('1', 7, 5, 5)")
    raw.exec("PRAGMA user_version = 1")
    raw.close()
    const refused = errorOf(() => openMirrorForRead(path))
    expect(isToolError(refused) && refused.code).toBe("upstream_error")
    expect(refused.message).toContain("older version")
    const mirror = tracked(openMirrorForWrite(path))
    expect(version(mirror)).toBe(MIRROR_VERSION)
    expect(columnOf(mirror, "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'messages_time'")).toEqual([
      "messages_time",
    ])
    expect(columnOf(mirror, "SELECT id FROM messages")).toEqual([7])
    tracked(openMirrorForRead(path))
  })

  test("refuses a mirror of a newer version and leaves it untouched", () => {
    writeNewerMirror()
    const before = statSync(path).size
    const error = errorOf(() => openMirrorForWrite(path))
    expect(isToolError(error) && error.code).toBe("upstream_error")
    expect(error.message).toBe("This mirror was written by a newer version of these tools; update them.")
    expect(error.message).not.toContain(dir)
    const raw = new DatabaseSync(path)
    expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 99 })
    expect(raw.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" })
    raw.close()
    expect(statSync(path).size).toBe(before)
  })
})

describe("openMirrorForRead", () => {
  test("hides the path when the file is unreadable", () => {
    tracked(openMirrorForWrite(path)).close()
    chmodSync(path, 0)
    try {
      const error = errorOf(() => openMirrorForRead(path))
      expect(isToolError(error) && error.code).toBe("upstream_error")
      expect(error.message).toContain("(EACCES)")
      expect(error.message).not.toContain(dir)
      expect(error.message).not.toContain(path)
    } finally {
      chmodSync(path, 0o600)
    }
  })

  test("says nothing was received when the file does not exist, and creates nothing", () => {
    const error = errorOf(() => openMirrorForRead(path))
    expect(isToolError(error) && error.code).toBe("not_found")
    expect(error.message).toBe("Nothing has been received for this account yet: its sync service has not run.")
    expect(readdirSync(dir)).toEqual([])
  })

  test("says the same of a file the sync service created but never set up", () => {
    writeFileSync(path, "")
    const error = errorOf(() => openMirrorForRead(path))
    expect(isToolError(error) && error.code).toBe("not_found")
    expect(readdirSync(dir)).toEqual(["mirror.sqlite"])
  })

  test("reads what the writer committed, and refuses to write", () => {
    const writer = tracked(openMirrorForWrite(path))
    setMeta(writer, { seen: 1 })
    const reader = tracked(openMirrorForRead(path))
    expect(getMeta(reader)).toEqual({ seen: "1" })
    expect(errorOf(() => setMeta(reader, { seen: 2 })).message).toContain("readonly")
    expect(errorOf(() => reader.exec("DELETE FROM meta")).message).toContain("readonly")
    expect(getMeta(writer)).toEqual({ seen: "1" })
  })

  test("leaves nothing behind once the writer has stopped", () => {
    tracked(openMirrorForWrite(path)).close()
    expect(readdirSync(dir)).toEqual(["mirror.sqlite"])
    const before = statSync(path)
    openMirrorForRead(path).close()
    expect(readdirSync(dir)).toEqual(["mirror.sqlite"])
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs)
  })

  test("refuses a mirror of a newer version", () => {
    writeNewerMirror()
    const error = errorOf(() => openMirrorForRead(path))
    expect(isToolError(error) && error.code).toBe("upstream_error")
    expect(error.message).toBe("This mirror was written by a newer version of these tools; update them.")
    expect(existsSync(`${path}-wal`)).toBe(false)
  })
})

describe("inTransaction", () => {
  test("commits what the function wrote and returns its result", () => {
    const mirror = tracked(openMirrorForWrite(path))
    expect(inTransaction(mirror, () => setMeta(mirror, { a: "1" }) ?? "done")).toBe("done")
    expect(mirror.isTransaction).toBe(false)
    expect(getMeta(mirror)).toEqual({ a: "1" })
  })

  test("rolls back and rethrows when the function throws", () => {
    const mirror = tracked(openMirrorForWrite(path))
    const failure = new Error("stop")
    const error = errorOf(() =>
      inTransaction(mirror, () => {
        setMeta(mirror, { a: "1" })
        throw failure
      }),
    )
    expect(error).toBe(failure)
    expect(mirror.isTransaction).toBe(false)
    expect(getMeta(mirror)).toEqual({})
  })

  test("rolls back when a statement fails inside it", () => {
    const mirror = tracked(openMirrorForWrite(path))
    const error = errorOf(() =>
      inTransaction(mirror, () => {
        setMeta(mirror, { a: "1" })
        mirror.exec("INSERT INTO chats (id, kind, updated) VALUES ('x', 'nonsense', 0)")
      }),
    )
    expect(error.message).toContain("CHECK")
    expect(rowsOf(mirror, "SELECT key FROM meta")).toEqual([])
  })
})

describe("meta", () => {
  test("stores values as text, replaces them and removes a key set to null", () => {
    const mirror = tracked(openMirrorForWrite(path))
    expect(getMeta(mirror)).toEqual({})
    setMeta(mirror, { stale: 1, name: "x" })
    expect(getMeta(mirror)).toEqual({ stale: "1", name: "x" })
    setMeta(mirror, { stale: 0, name: null })
    expect(getMeta(mirror)).toEqual({ stale: "0" })
  })
})
