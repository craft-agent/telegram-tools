import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ToolError } from "../errors"
import { ensureLabelDir } from "./labels"
import { removeLabel } from "./removal"

/** A process id no process has. */
const DEAD_PID = 2_147_483_646

const STILL_RUNNING = "The sync service for this label is still running; stop it first."

let stateDir: string
let holders: ChildProcess[] = []

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "tg-removal-"))
})

afterEach(async () => {
  for (const holder of holders) holder.kill("SIGKILL")
  holders = []
  await rm(stateDir, { recursive: true, force: true })
})

/** Starts a process that stays alive, for the lock to name. */
function liveHolder(): ChildProcess {
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  holders.push(holder)
  return holder
}

describe("removeLabel", () => {
  test("throws not_found when the label does not exist, without uninstalling", async () => {
    let uninstalled = false
    const error = await removeLabel({
      stateDir,
      label: "nonexistent",
      uninstall: async () => {
        uninstalled = true
      },
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("not_found")
    expect(uninstalled).toBe(false)
  })

  test("refuses when the label directory is a symlink", async () => {
    const targetDir = await mkdtemp(join(tmpdir(), "tg-removal-target-"))
    try {
      await symlink(targetDir, join(stateDir, "linklabel"))

      const error = await removeLabel({ stateDir, label: "linklabel", uninstall: async () => {} }).catch(
        (e: unknown) => e,
      )

      expect(error).toBeInstanceOf(ToolError)
      expect((error as ToolError).code).toBe("invalid_argument")
      expect((error as ToolError).message).toContain("is not a directory")
      expect((await lstat(targetDir)).isDirectory()).toBe(true)
    } finally {
      await rm(targetDir, { recursive: true, force: true })
    }
  })

  test("refuses when a live process still holds the sync lock after waiting", async () => {
    const paths = await ensureLabelDir(stateDir, "work")
    await writeFile(paths.syncLock, `${liveHolder().pid}\n`, "utf8")
    let uninstalled = false
    const start = Date.now()

    const error = await removeLabel({
      stateDir,
      label: "work",
      uninstall: async () => {
        uninstalled = true
      },
      pollTimeoutMs: 50,
      pollIntervalMs: 10,
    }).catch((e: unknown) => e)

    expect(Date.now() - start).toBeGreaterThanOrEqual(40)
    expect(uninstalled).toBe(true)
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("invalid_argument")
    expect((error as ToolError).message).toBe(STILL_RUNNING)
    expect((await lstat(paths.dir)).isDirectory()).toBe(true)
  })

  test("removes once the holder exits while it waits", async () => {
    const paths = await ensureLabelDir(stateDir, "work")
    const holder = liveHolder()
    await writeFile(paths.syncLock, `${holder.pid}\n`, "utf8")

    await removeLabel({
      stateDir,
      label: "work",
      uninstall: async () => {
        setTimeout(() => holder.kill("SIGKILL"), 20)
      },
      pollTimeoutMs: 2_000,
      pollIntervalMs: 10,
    })

    await expect(lstat(paths.dir)).rejects.toThrow()
  })

  test("a lock naming a dead process or this one does not block", async () => {
    for (const pid of [DEAD_PID, process.pid]) {
      const paths = await ensureLabelDir(stateDir, "work")
      await writeFile(paths.syncLock, `${pid}\n`, "utf8")

      await removeLabel({ stateDir, label: "work", uninstall: async () => {}, pollTimeoutMs: 50, pollIntervalMs: 10 })

      await expect(lstat(paths.dir)).rejects.toThrow()
    }
  })

  test("deletes the directory while holding the lock, which goes with it", async () => {
    const paths = await ensureLabelDir(stateDir, "work")

    await removeLabel({ stateDir, label: "work", uninstall: async () => {} })

    await expect(lstat(paths.dir)).rejects.toThrow()
    await expect(lstat(paths.syncLock)).rejects.toThrow()
  })

  test("removes the label directory and all its contents, and leaves other labels", async () => {
    const paths = await ensureLabelDir(stateDir, "default")
    const other = await ensureLabelDir(stateDir, "other")
    await writeFile(join(paths.dir, "somefile.txt"), "hello", "utf8")
    let uninstalled = false

    await removeLabel({
      stateDir,
      label: "default",
      uninstall: async () => {
        uninstalled = true
      },
    })

    expect(uninstalled).toBe(true)
    await expect(lstat(paths.dir)).rejects.toThrow()
    expect((await lstat(other.dir)).isDirectory()).toBe(true)
  })
})
