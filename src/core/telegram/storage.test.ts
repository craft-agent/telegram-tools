import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { StorageManager, TelegramStorageManager, type ICorePlatform } from "@mtcute/core"
import { LogManager } from "@mtcute/core/utils.js"
import { NodeSqliteStorageDriver, StorageFrozenError, TelegramStorage } from "./storage"

const OWNER_ONLY = 0o600
const DC = 2
const AUTH_KEY = Uint8Array.from({ length: 256 }, (_, i) => (i * 7) % 256)
const PEER = {
  id: -1001234567890,
  accessHash: "5678901234567890",
  isMin: false,
  usernames: ["made_up", "made_up_2"],
  updated: 1_700_000_000_000,
  phone: "15550100",
  complete: Uint8Array.from([1, 2, 3, 4]),
}
const UPDATES_STATE: [pts: number, qts: number, date: number, seq: number] = [1000, 20, 1_700_000_000, 7]
const CHANNEL_ID = 1234567
const CHANNEL_PTS = 4242

type StorageManagerOptions = ConstructorParameters<typeof StorageManager>[0]

const platform: ICorePlatform = {
  beforeExit: () => () => {},
  log: () => {},
  getDefaultLogLevel: () => 0,
  getDeviceModel: () => "test",
}

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "telegram-storage-"))
  path = join(dir, "session.db")
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Opens `storage` the way a client does and returns its managers; `close` saves and releases the file. */
async function open() {
  const storage = new TelegramStorage(path)
  const mt = new StorageManager({
    provider: storage,
    platform,
    log: new LogManager("test", platform),
    readerMap: {},
    writerMap: {} as StorageManagerOptions["writerMap"],
    cleanup: false,
  })
  await mt.load()
  const telegram = new TelegramStorageManager(mt, { provider: storage })
  return {
    storage,
    mt,
    telegram,
    close: async () => {
      await telegram.close()
      await mt.save()
      await mt.destroy()
    },
  }
}

describe("transactions", () => {
  function openDatabase() {
    const db = new NodeSqliteStorageDriver(path)._createDatabase()
    db.exec("create table t (n integer primary key)")
    const count = () => (db.prepare("select count(*) as c from t").get() as { c: number }).c
    const insert = db.prepare<[number]>("insert into t (n) values (?)")
    return { db, count, insert }
  }

  test("commits what the function did and returns its result", () => {
    const { db, count, insert } = openDatabase()
    const add = db.transaction((a: number, b: number) => {
      insert.run(a)
      insert.run(b)
      return a + b
    })
    expect(add(1, 2)).toBe(3)
    expect(count()).toBe(2)
    db.close()
  })

  test("rolls back and rethrows when the function throws", () => {
    const { db, count, insert } = openDatabase()
    const fail = db.transaction(() => {
      insert.run(1)
      throw new Error("boom")
    })
    expect(() => fail()).toThrow("boom")
    expect(count()).toBe(0)
    insert.run(2)
    expect(count()).toBe(1)
    db.close()
  })

  test("a nested call that throws is undone and leaves the outer transaction intact", () => {
    const { db, count, insert } = openDatabase()
    const inner = db.transaction(() => {
      insert.run(2)
      throw new Error("inner")
    })
    const outer = db.transaction(() => {
      insert.run(1)
      expect(() => inner()).toThrow("inner")
      insert.run(3)
    })
    outer()
    expect(count()).toBe(2)
    expect(db.prepare("select n from t order by n").all()).toEqual([{ n: 1 }, { n: 3 }])
    db.close()
  })

  test("a nested call that succeeds is undone with the outer transaction", () => {
    const { db, count, insert } = openDatabase()
    const inner = db.transaction(() => insert.run(2))
    const outer = db.transaction(() => {
      insert.run(1)
      inner()
      throw new Error("outer")
    })
    expect(() => outer()).toThrow("outer")
    expect(count()).toBe(0)
    db.close()
  })

  test("a transaction after a failed one starts clean", () => {
    const { db, count, insert } = openDatabase()
    const fail = db.transaction(() => {
      insert.run(1)
      throw new Error("boom")
    })
    expect(() => fail()).toThrow("boom")
    db.transaction(() => insert.run(2))()
    expect(count()).toBe(1)
    db.close()
  })
})

describe("statements", () => {
  test("get returns undefined for no row and rows are plain objects with Buffer blobs", () => {
    const db = new NodeSqliteStorageDriver(path)._createDatabase()
    db.exec("create table t (id integer primary key, data blob, note text)")
    const insert = db.prepare<[number, Uint8Array | null, string | null]>("insert into t values (?, ?, ?)")
    const bytes = new Uint8Array(new ArrayBuffer(16), 4, 4).fill(7)
    insert.run(1, bytes, "x")
    insert.run(2, new Uint8Array(0), null)
    insert.run(3, null, "y")

    const byId = db.prepare<[number]>("select * from t where id = ?")
    expect(byId.get(99)).toBeUndefined()
    const row = byId.get(1) as { id: number; data: Buffer; note: string }
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype)
    expect(Buffer.isBuffer(row.data)).toBe(true)
    expect(row).toEqual({ id: 1, data: Buffer.from([7, 7, 7, 7]), note: "x" })
    expect(byId.get(2)).toEqual({ id: 2, data: Buffer.alloc(0), note: null })
    expect(byId.get(3)).toEqual({ id: 3, data: null, note: "y" })
    expect(db.prepare("select id from t order by id").all()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
    db.close()
  })

  test("close can be called twice", () => {
    const db = new NodeSqliteStorageDriver(path)._createDatabase()
    db.close()
    expect(() => db.close()).not.toThrow()
  })
})

describe("freezing", () => {
  test("every write through a frozen driver throws StorageFrozenError, and reads keep working", () => {
    const driver = new NodeSqliteStorageDriver(path)
    const db = driver._createDatabase()
    db.exec("create table t (n integer primary key)")
    const insert = db.prepare<[number]>("insert into t (n) values (?)")
    insert.run(1)

    driver.freeze()

    expect(() => insert.run(2)).toThrow(StorageFrozenError)
    expect(() => db.exec("insert into t (n) values (3)")).toThrow(StorageFrozenError)
    expect(() => db.transaction(() => insert.run(4))()).toThrow(StorageFrozenError)
    expect(db.prepare("select n from t order by n").all()).toEqual([{ n: 1 }])
    expect(db.prepare<[number]>("select n from t where n = ?").get(1)).toEqual({ n: 1 })
    db.close()
  })

  test("a frozen storage fails the save of the update state and keeps the one saved before", async () => {
    const first = await open()
    const [pts, qts, date, seq] = UPDATES_STATE
    await first.telegram.updates.setPts(pts)
    await first.telegram.updates.setQts(qts)
    await first.telegram.updates.setDate(date)
    await first.telegram.updates.setSeq(seq)
    await first.mt.save()

    first.storage.freeze()
    await first.telegram.updates.setPts(pts + 10)

    await expect(first.mt.save()).rejects.toThrow(StorageFrozenError)
    await first.mt.destroy()

    const second = await open()
    expect(await second.telegram.updates.getState()).toEqual(UPDATES_STATE)
    await second.close()
  })
})

describe("TelegramStorage", () => {
  test("auth keys, peers and the update state survive closing and reopening", async () => {
    const first = await open()
    await first.storage.authKeys.set(DC, AUTH_KEY)
    await first.storage.authKeys.setTemp(DC, 1, AUTH_KEY, 2_000_000_000)
    const [pts, qts, date, seq] = UPDATES_STATE
    await first.telegram.updates.setPts(pts)
    await first.telegram.updates.setQts(qts)
    await first.telegram.updates.setDate(date)
    await first.telegram.updates.setSeq(seq)
    await first.telegram.updates.setChannelPts(CHANNEL_ID, CHANNEL_PTS)
    await first.storage.kv.set("empty", new Uint8Array(0))
    await first.storage.peers.store(PEER)
    await first.close()

    const second = await open()
    const reopened = second.storage
    expect(await reopened.authKeys.get(DC)).toEqual(Buffer.from(AUTH_KEY))
    expect(await reopened.authKeys.getTemp(DC, 1, 1_900_000_000)).toEqual(Buffer.from(AUTH_KEY))
    expect(await reopened.authKeys.getTemp(DC, 1, 2_100_000_000)).toBeNull()
    expect(await reopened.authKeys.get(DC + 1)).toBeNull()
    expect(await second.telegram.updates.getState()).toEqual(UPDATES_STATE)
    expect(await second.telegram.updates.getChannelPts(CHANNEL_ID)).toBe(CHANNEL_PTS)
    expect(await second.telegram.updates.getChannelPts(CHANNEL_ID + 1)).toBeNull()
    expect((await reopened.kv.get("empty"))?.length).toBe(0)

    const stored = await reopened.peers.getById(PEER.id)
    expect(stored).toEqual({ ...PEER, complete: Buffer.from(PEER.complete) })
    expect(await reopened.peers.getByUsername("made_up_2")).toEqual(stored)
    expect(await reopened.peers.getByPhone(PEER.phone)).toEqual(stored)
    expect(await reopened.peers.getById(1)).toBeNull()
    await second.close()
  })

  test("a deleted auth key is gone after reopening", async () => {
    const first = await open()
    await first.storage.authKeys.set(DC, AUTH_KEY)
    await first.storage.authKeys.set(DC, null)
    await first.close()
    const second = await open()
    expect(await second.storage.authKeys.get(DC)).toBeNull()
    await second.close()
  })

  test("the database and its journal files are readable by the owner only", async () => {
    const session = await open()
    await session.storage.authKeys.set(DC, AUTH_KEY)
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      expect(statSync(file).mode & 0o777).toBe(OWNER_ONLY)
    }
    await session.close()
    expect(statSync(path).mode & 0o777).toBe(OWNER_ONLY)
  })

  test("an existing file keeps its mode", async () => {
    writeFileSync(path, "")
    chmodSync(path, 0o640)
    const session = await open()
    await session.close()
    expect(statSync(path).mode & 0o777).toBe(0o640)
  })

  test("the database runs in WAL mode", async () => {
    const db = new NodeSqliteStorageDriver(path)._createDatabase()
    expect(db.prepare("pragma journal_mode").get()).toEqual({ journal_mode: "wal" })
    db.close()
  })

  test("better-sqlite3 is never imported or loaded", async () => {
    const source = readFileSync(new URL("./storage.ts", import.meta.url), "utf8")
    const specifiers = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1])
    expect(specifiers).toContain("node:sqlite")
    expect(specifiers.filter((specifier) => specifier?.includes("sqlite3"))).toEqual([])

    const session = await open()
    await session.close()
    expect(Object.keys(require.cache).filter((id) => id.includes("better-sqlite3"))).toEqual([])
  })
})
