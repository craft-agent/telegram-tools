import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { makeTempDir } from "./mirror.testing"
import { acquireSyncLock, lockHolder } from "./sync-lock"

/** A process id no process has. */
const DEAD_PID = 2_147_483_646

let dir: string
let path: string
let holders: ChildProcess[] = []

beforeEach(() => {
  dir = makeTempDir()
  path = join(dir, "sync.lock")
})

afterEach(() => {
  for (const holder of holders) holder.kill("SIGKILL")
  holders = []
  rmSync(dir, { recursive: true, force: true })
})

/** Starts a process that stays alive, for the lock to name. */
function liveHolder(): number {
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  holders.push(holder)
  return holder.pid!
}

const readLock = () => readFileSync(path, "utf8")

describe("lockHolder", () => {
  test("names a live process other than this one, and nothing else", () => {
    const holder = liveHolder()
    writeFileSync(path, `${holder}\n`)
    expect(lockHolder(path)).toBe(holder)

    for (const content of [`${process.pid}\n`, `${DEAD_PID}\n`, "garbage"]) {
      writeFileSync(path, content)
      expect(lockHolder(path)).toBeUndefined()
    }
    rmSync(path)
    expect(lockHolder(path)).toBeUndefined()
  })
})

describe("acquireSyncLock", () => {
  test("creates a private file naming this process, and the release removes it", () => {
    const release = acquireSyncLock(path)

    expect(release).toBeDefined()
    expect(readLock()).toBe(`${process.pid}\n`)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    release!()
    expect(existsSync(path)).toBe(false)
  })

  test("publishes a complete lock: no temporary file is left and the pid is in place at once", () => {
    const release = acquireSyncLock(path)!

    expect(readdirSync(dir)).toEqual(["sync.lock"])
    expect(readLock()).toBe(`${process.pid}\n`)
    release()
    expect(readdirSync(dir)).toEqual([])
  })

  test("a refused try leaves the holder's lock whole and no temporary file", () => {
    const holder = liveHolder()
    writeFileSync(path, `${holder}\n`)

    expect(acquireSyncLock(path)).toBeUndefined()
    expect(readdirSync(dir)).toEqual(["sync.lock"])
    expect(readLock()).toBe(`${holder}\n`)
  })

  test("a lock naming a live process is left alone", () => {
    const holder = liveHolder()
    writeFileSync(path, `${holder}\n`)

    expect(acquireSyncLock(path)).toBeUndefined()
    expect(readLock()).toBe(`${holder}\n`)
  })

  test("a lock whose process is gone, or that holds no pid, is taken over", () => {
    for (const content of [`${DEAD_PID}\n`, "garbage", "", "0\n", "-3\n"]) {
      writeFileSync(path, content)

      const release = acquireSyncLock(path)

      expect(release).toBeDefined()
      expect(readLock()).toBe(`${process.pid}\n`)
      release!()
    }
  })

  test("a second try while this process holds the lock still finds it taken over by its own pid", () => {
    const first = acquireSyncLock(path)

    expect(acquireSyncLock(path)).toBeDefined()
    first!()
  })

  test("the release leaves a lock that another process took over", () => {
    const release = acquireSyncLock(path)!
    const holder = liveHolder()
    writeFileSync(path, `${holder}\n`)

    release()

    expect(readLock()).toBe(`${holder}\n`)
  })

  test("a path that cannot be created is an error, not a held lock", () => {
    expect(() => acquireSyncLock(join(dir, "missing", "sync.lock"))).toThrow()
  })
})
