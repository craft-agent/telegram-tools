import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ToolError } from "../errors"
import { ensureLabelDir, type LabelPaths } from "./labels"
import { logoutLabel, type LogoutClient } from "./logout"

/** A process id no process has. */
const DEAD_PID = 2_147_483_646

let stateDir: string
let paths: LabelPaths
let holders: ChildProcess[] = []

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "tg-logout-"))
  paths = await ensureLabelDir(stateDir, "work")
})

afterEach(async () => {
  for (const holder of holders) holder.kill("SIGKILL")
  holders = []
  await rm(stateDir, { recursive: true, force: true })
})

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

/** Writes the session files, the app's credentials and the mirror. */
async function writeState(): Promise<void> {
  for (const path of [paths.session, `${paths.session}-wal`, `${paths.session}-shm`, paths.app, paths.mirror]) {
    await writeFile(path, "x")
  }
}

/** A fake client that records its calls; `logOut` fails when `failure` is given. */
function fakeClient(failure?: Error) {
  const calls: string[] = []
  const client: LogoutClient = {
    logOut: async () => {
      calls.push("logOut")
      if (failure) throw failure
    },
    destroy: async () => {
      calls.push("destroy")
    },
  }
  return { client, calls }
}

describe("logoutLabel", () => {
  test("ends the session, closes the client and removes the session files only", async () => {
    await writeState()
    const { client, calls } = fakeClient()

    const result = await logoutLabel({ paths, openClient: async () => client })

    expect(result).toEqual({ endedAtTelegram: true })
    expect(calls).toEqual(["logOut", "destroy"])
    expect(await exists(paths.session)).toBe(false)
    expect(await exists(`${paths.session}-wal`)).toBe(false)
    expect(await exists(`${paths.session}-shm`)).toBe(false)
    expect(await exists(paths.app)).toBe(true)
    expect(await exists(paths.mirror)).toBe(true)
  })

  test("a failing logOut still removes the session, destroys the client and says it was not ended", async () => {
    await writeState()
    const { client, calls } = fakeClient(new Error("network down for +15550100"))

    const result = await logoutLabel({ paths, openClient: async () => client })

    expect(result).toEqual({ endedAtTelegram: false })
    expect(calls).toEqual(["logOut", "destroy"])
    expect(await exists(paths.session)).toBe(false)
    expect(await exists(paths.app)).toBe(true)
  })

  test("a client that cannot be opened still removes the session", async () => {
    await writeState()

    const result = await logoutLabel({
      paths,
      openClient: async () => {
        throw new Error("cannot connect")
      },
    })

    expect(result).toEqual({ endedAtTelegram: false })
    expect(await exists(paths.session)).toBe(false)
  })

  test("a client that fails to destroy does not undo the logout", async () => {
    await writeState()
    const client: LogoutClient = {
      logOut: async () => {},
      destroy: async () => {
        throw new Error("close failed")
      },
    }

    const result = await logoutLabel({ paths, openClient: async () => client })

    expect(result).toEqual({ endedAtTelegram: true })
    expect(await exists(paths.session)).toBe(false)
  })

  test("throws not_found without opening a client when there is no session", async () => {
    let opened = false

    const error = await logoutLabel({
      paths,
      openClient: async () => {
        opened = true
        return fakeClient().client
      },
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("not_found")
    expect((error as ToolError).message).toBe("This account is not logged in.")
    expect(opened).toBe(false)
  })

  test("refuses while a live process holds the sync lock, and keeps the session", async () => {
    await writeState()
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    holders.push(holder)
    await writeFile(paths.syncLock, `${holder.pid}\n`)
    let opened = false

    const error = await logoutLabel({
      paths,
      openClient: async () => {
        opened = true
        return fakeClient().client
      },
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("invalid_argument")
    expect((error as ToolError).message).toBe("The sync service for this label is running; stop it first.")
    expect(opened).toBe(false)
    expect(await exists(paths.session)).toBe(true)
  })

  test("holds the lock for the whole run and releases it afterwards", async () => {
    await writeState()
    let heldWhileOpening: string | undefined

    await logoutLabel({
      paths,
      openClient: async () => {
        heldWhileOpening = await readFile(paths.syncLock, "utf8")
        return fakeClient().client
      },
    })

    expect(heldWhileOpening).toBe(`${process.pid}\n`)
    expect(await exists(paths.syncLock)).toBe(false)
  })

  test("a lock naming a dead process does not block", async () => {
    await writeState()
    await writeFile(paths.syncLock, `${DEAD_PID}\n`)

    const result = await logoutLabel({ paths, openClient: async () => fakeClient().client })

    expect(result).toEqual({ endedAtTelegram: true })
  })
})
