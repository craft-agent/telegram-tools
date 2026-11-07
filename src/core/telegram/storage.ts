import { Buffer } from "node:buffer"
import { closeSync, openSync } from "node:fs"
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from "node:sqlite"
import { BaseSqliteStorage, BaseSqliteStorageDriver, type ISqliteDatabase, type ISqliteStatement } from "@mtcute/core"

/** The mode a new database file gets; the `-wal` and `-shm` files SQLite adds copy the database file's mode. */
const DATABASE_FILE_MODE = 0o600
/** How long a statement waits for a lock another connection holds, the default of `better-sqlite3`. */
const BUSY_TIMEOUT_MS = 5_000
/** The name every nested transaction's savepoint takes: SQLite releases and rolls back to the innermost one with a name. */
const SAVEPOINT = "mtcute_nested"

/** What a write through a frozen storage throws. */
export class StorageFrozenError extends Error {
  constructor() {
    super("The session storage is frozen; it takes no more writes.")
    this.name = "StorageFrozenError"
  }
}

type AnyFunction = (...args: any[]) => any

/**
 * Wraps `fn` the way `better-sqlite3`'s `transaction` does: each call runs
 * in `begin`/`commit`, or in a savepoint when a transaction is already open,
 * and a throw rolls back to where the call began before it propagates.
 */
function transaction<F extends AnyFunction>(db: DatabaseSync, fn: F): F {
  return function (this: unknown, ...args: Parameters<F>): ReturnType<F> {
    const nested = db.isTransaction
    db.exec(nested ? `savepoint ${SAVEPOINT}` : "begin")
    try {
      const result: ReturnType<F> = fn.apply(this, args)
      db.exec(nested ? `release ${SAVEPOINT}` : "commit")
      return result
    } catch (error) {
      rollback(db, nested)
      throw error
    }
  } as F
}

/** Undoes the failed call and keeps its error: a rollback that cannot run, because SQLite already ended the transaction, is ignored. */
function rollback(db: DatabaseSync, nested: boolean): void {
  try {
    if (!db.isTransaction) return
    db.exec(nested ? `rollback to ${SAVEPOINT}; release ${SAVEPOINT}` : "rollback")
  } catch {
    // The original error is the one to report.
  }
}

/** A row as `better-sqlite3` returns it: a plain object whose blobs are `Buffer`s, not bare `Uint8Array`s. */
function toRow(row: Record<string, SQLOutputValue>): Record<string, unknown> {
  const plain: Record<string, unknown> = {}
  for (const [column, value] of Object.entries(row)) {
    plain[column] = value instanceof Uint8Array ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : value
  }
  return plain
}

/** Exposes a prepared statement as mtcute calls it: positional parameters, no result from `run`, `undefined` from `get` when no row matches. */
function wrapStatement(statement: StatementSync, guardWrite: () => void): ISqliteStatement {
  return {
    run: (...params) => {
      guardWrite()
      statement.run(...(params as SQLInputValue[]))
    },
    get: (...params) => {
      const row = statement.get(...(params as SQLInputValue[]))
      return row && toRow(row)
    },
    all: (...params) => statement.all(...(params as SQLInputValue[])).map(toRow),
  }
}

/**
 * mtcute's SQLite storage driver on Node's built-in `node:sqlite`, so no
 * native module is loaded. It opens the database as `@mtcute/node`'s driver
 * does on `better-sqlite3`: in WAL mode, with a 5 second busy timeout, and
 * with transactions, rows and blobs shaped the way mtcute reads them. A new
 * database file is created readable and writable by its owner only; an
 * existing file keeps its mode.
 */
export class NodeSqliteStorageDriver extends BaseSqliteStorageDriver {
  private frozen = false

  constructor(readonly path: string) {
    super()
  }

  /**
   * From now on every write through this driver (a statement's `run`, `exec`,
   * and so a transaction that writes) throws `StorageFrozenError`; reads keep
   * working. It cannot be undone.
   */
  freeze(): void {
    this.frozen = true
  }

  private guardWrite = (): void => {
    if (this.frozen) throw new StorageFrozenError()
  }

  _createDatabase(): ISqliteDatabase {
    // Creating the file first gives it its mode from the start; `open` with an existing file leaves the mode alone.
    closeSync(openSync(this.path, "a", DATABASE_FILE_MODE))
    const db = new DatabaseSync(this.path, { timeout: BUSY_TIMEOUT_MS })
    try {
      db.exec("pragma journal_mode = WAL")
    } catch (error) {
      db.close()
      throw error
    }
    return {
      transaction: (fn) => transaction(db, fn),
      prepare: (sql) => wrapStatement(db.prepare(sql), this.guardWrite),
      exec: (sql) => {
        this.guardWrite()
        db.exec(sql)
      },
      close: () => {
        if (db.isOpen) db.close()
      },
    }
  }
}

/**
 * mtcute's storage for a client (auth keys, the peers cache and the update
 * state) in the SQLite file at `path`, on `NodeSqliteStorageDriver`.
 */
export class TelegramStorage extends BaseSqliteStorage {
  private readonly sqliteDriver: NodeSqliteStorageDriver

  constructor(readonly path: string) {
    const driver = new NodeSqliteStorageDriver(path)
    super(driver)
    this.sqliteDriver = driver
  }

  /**
   * Makes every later write to the session file throw `StorageFrozenError`,
   * so that mtcute's save of the update state fails and the persisted state
   * stays where the last complete save left it. Reads keep working.
   */
  freeze(): void {
    this.sqliteDriver.freeze()
  }
}
