import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { ToolError } from "../errors"
import { labelPaths } from "../telegram/labels"
import { openMirrorForWrite, setMeta } from "../telegram/mirror"
import { META } from "../telegram/mirror-meta"
import { MIRROR_VERSION } from "../telegram/mirror-schema"
import { NOW, makeTempDir } from "../telegram/mirror.testing"
import { annotations, invoke } from "../tool"
import { telegramAccountRead } from "./read"

let stateDir: string
const children: ChildProcess[] = []

beforeEach(() => {
  stateDir = makeTempDir()
})

afterEach(() => {
  for (const child of children) {
    try {
      child.kill("SIGKILL")
    } catch {}
  }
  children.length = 0
  rmSync(stateDir, { recursive: true, force: true })
})

function label(name = "default", loggedIn = true) {
  const paths = labelPaths(stateDir, name)
  mkdirSync(paths.dir, { recursive: true })
  if (loggedIn) writeFileSync(paths.session, "")
  return paths
}

function mirrorMeta(meta: Parameters<typeof setMeta>[1], name = "default", version = MIRROR_VERSION) {
  const paths = labelPaths(stateDir, name)
  const mirror = openMirrorForWrite(paths.mirror)
  try {
    setMeta(mirror, meta)
    mirror.exec(`PRAGMA user_version = ${version}`)
  } finally {
    mirror.close()
  }
}

function read(args: unknown = {}) {
  return invoke(telegramAccountRead, args, { cwd: stateDir, stateDir })
}

async function failure(args: unknown) {
  try {
    await read(args)
  } catch (error) {
    if (error instanceof ToolError) return error
    throw error
  }
  throw new Error("Expected the call to fail")
}

function spawnLiveLockHolder(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  children.push(child)
  return child
}

describe("account read: login and selection", () => {
  test("publishes read annotations", () => {
    expect(annotations(telegramAccountRead)).toEqual({
      title: "Read account status",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    })
  })

  test("no labels returns an empty list without creating state", async () => {
    rmSync(stateDir, { recursive: true })
    expect(await read()).toEqual({ accounts: [] })
    expect(existsSync(stateDir)).toBe(false)
  })

  test("not logged in reports the login step and null metadata", async () => {
    const paths = label("default", false)
    expect(await read()).toEqual({
      accounts: [
        {
          label: "default",
          login: "not logged in",
          service: "never run",
          connected_at: null,
          last_received_at: null,
          refreshed_at: null,
          chats: null,
          followed: null,
          messages: null,
          error: null,
          action: "log_in",
          hint: "Log in to this account.",
        },
      ],
    })
    expect(existsSync(paths.mirror)).toBe(false)
    expect(existsSync(`${paths.mirror}-wal`)).toBe(false)
  })

  test("a logged-in account without a mirror needs the service", async () => {
    label("default", true)
    const [account] = (await read()).accounts
    expect(account?.login).toBe("logged in")
    expect(account?.service).toBe("never run")
    expect(account?.action).toBe("start_service")
    expect(account?.hint).toBe("Start the sync service to receive messages for this account.")
  })

  test("lists sorted labels, or only the named label", async () => {
    label("zebra")
    label("alpha")
    expect((await read()).accounts.map((account) => account.label)).toEqual(["alpha", "zebra"])
    expect((await read({ account: "zebra" })).accounts.map((account) => account.label)).toEqual(["zebra"])
  })

  test("unknown account lists known labels as pickLabel does", async () => {
    label("default")
    const error = await failure({ account: "missing" })
    expect(error.code).toBe("not_found")
    expect(error.message).toBe('Telegram account "missing" was not found; known accounts: default.')
  })

  test("unknown account with no labels says none is logged in", async () => {
    const error = await failure({ account: "missing" })
    expect(error.code).toBe("not_found")
    expect(error.message).toContain("no Telegram account is logged in yet")
  })

  test.each([{ account: "../other" }, { account: "Bad" }, { account: 1 }, { extra: true }])(
    "refuses invalid arguments %j",
    async (args) => {
      expect((await failure(args)).code).toBe("invalid_argument")
    },
  )

  test("missing state directory is an entry-point bug", async () => {
    await expect(invoke(telegramAccountRead, {}, { cwd: stateDir })).rejects.toMatchObject({
      code: "internal_error",
    })
  })
})

describe("account read: service health", () => {
  test.each(["running", "starting"])("%s with a live lock holder is healthy", async (status) => {
    const paths = label()
    mirrorMeta({
      [META.status]: status,
      [META.connectedAt]: NOW,
      [META.lastReceivedAt]: NOW - 1000,
      [META.refreshedAt]: NOW - 2000,
    })
    const child = spawnLiveLockHolder()
    writeFileSync(paths.syncLock, `${child.pid}\n`)
    const [account] = (await read()).accounts
    expect(account?.service).toBe(status)
    expect(account?.action).toBeNull()
    expect(account?.hint).toBeNull()
    expect(account?.connected_at).toBe(new Date(NOW).toISOString())
    expect(account?.last_received_at).toBe(new Date(NOW - 1000).toISOString())
    expect(account?.refreshed_at).toBe(new Date(NOW - 2000).toISOString())
  })

  test.each(["running", "starting"])("%s with a dead lock is not running", async (status) => {
    const paths = label()
    mirrorMeta({ [META.status]: status })
    writeFileSync(paths.syncLock, "2147483647\n")
    const [account] = (await read()).accounts
    expect(account?.service).toBe("not running")
    expect(account?.action).toBe("start_service")
  })

  test("a missing lock corrects a running status", async () => {
    label()
    mirrorMeta({ [META.status]: "running" })
    expect((await read()).accounts[0]?.service).toBe("not running")
  })

  test("failed reports the recorded error and asks to check the service log", async () => {
    label()
    mirrorMeta({ [META.status]: "failed", [META.error]: "The daemon stopped unexpectedly." })
    const [account] = (await read()).accounts
    expect(account?.service).toBe("failed")
    expect(account?.error).toBe("The daemon stopped unexpectedly.")
    expect(account?.action).toBe("check_service")
    expect(account?.hint).toContain("log")
  })

  test("stopped needs the service started", async () => {
    label()
    mirrorMeta({ [META.status]: "stopped" })
    const [account] = (await read()).accounts
    expect(account?.service).toBe("stopped")
    expect(account?.action).toBe("start_service")
  })

  test("logged out by Telegram needs login again", async () => {
    const paths = label()
    const beforeRun = new Date(NOW - 1000)
    utimesSync(paths.session, beforeRun, beforeRun)
    mirrorMeta({ [META.status]: "logged out", [META.startedAt]: NOW })
    const [account] = (await read()).accounts
    expect(account?.login).toBe("logged out")
    expect(account?.service).toBe("stopped")
    expect(account?.action).toBe("log_in")
    expect(account?.hint).toBe("Telegram ended this session; log in again.")
  })

  test("a session file newer than started_at reports logged in with service stopped", async () => {
    const paths = label()
    const afterRun = new Date(NOW + 1000)
    utimesSync(paths.session, afterRun, afterRun)
    mirrorMeta({ [META.status]: "logged out", [META.startedAt]: NOW })
    const [account] = (await read()).accounts
    expect(account?.login).toBe("logged in")
    expect(account?.service).toBe("stopped")
    expect(account?.action).toBe("start_service")
  })

  test("a newer mirror reports the refusal and restart action", async () => {
    const paths = label()
    mirrorMeta({}, "default", MIRROR_VERSION + 1)
    const [account] = (await read()).accounts
    expect(account?.service).toBe("failed")
    expect(account?.error).toContain("newer version")
    expect(account?.action).toBe("start_service")
    expect(existsSync(`${paths.mirror}-wal`)).toBe(false)
    expect(existsSync(`${paths.mirror}-shm`)).toBe(false)
  })

  test("an uninitialized mirror is treated as never run", async () => {
    const paths = label()
    mirrorMeta({}, "default", 0)
    const [account] = (await read()).accounts
    expect(account?.service).toBe("never run")
    expect(account?.error).toBeNull()
    expect(account?.action).toBe("start_service")
    expect(existsSync(`${paths.mirror}-wal`)).toBe(false)
    expect(existsSync(`${paths.mirror}-shm`)).toBe(false)
  })

  test("an initialized mirror with no recorded status reports never run", async () => {
    const paths = label()
    openMirrorForWrite(paths.mirror).close()

    const [account] = (await read()).accounts
    expect(account).toEqual({
      label: "default",
      login: "logged in",
      service: "never run",
      connected_at: null,
      last_received_at: null,
      refreshed_at: null,
      chats: 0,
      followed: 0,
      messages: 0,
      error: null,
      action: "start_service",
      hint: "Start the sync service to receive messages for this account.",
    })
    expect(existsSync(`${paths.mirror}-wal`)).toBe(false)
    expect(existsSync(`${paths.mirror}-shm`)).toBe(false)
  })

  const isRoot = typeof process.getuid === "function" && process.getuid() === 0
  test.skipIf(isRoot)("an unreadable mirror reports the failure without failing other labels", async () => {
    const broken = label("broken")
    writeFileSync(broken.mirror, "placeholder")
    chmodSync(broken.mirror, 0)

    const healthy = label("healthy")
    mirrorMeta({ [META.status]: "stopped" }, "healthy")

    try {
      const { accounts } = await read()
      expect(accounts).toEqual([
        {
          label: "broken",
          login: "logged in",
          service: "failed",
          connected_at: null,
          last_received_at: null,
          refreshed_at: null,
          chats: null,
          followed: null,
          messages: null,
          error: "the mirror cannot be read",
          action: "check_service",
          hint: "Check the sync service's status and log to find why it failed.",
        },
        expect.objectContaining({
          label: "healthy",
          service: "stopped",
          action: "start_service",
        }),
      ])
      expect(existsSync(`${broken.mirror}-wal`)).toBe(false)
      expect(existsSync(`${broken.mirror}-shm`)).toBe(false)
      expect(existsSync(`${healthy.mirror}-wal`)).toBe(false)
      expect(existsSync(`${healthy.mirror}-shm`)).toBe(false)
    } finally {
      chmodSync(broken.mirror, 0o600)
    }
  })

  test("a file that is not SQLite reports the failure without failing other labels", async () => {
    const corrupt = label("corrupt")
    writeFileSync(corrupt.mirror, "this is not a sqlite database\n")

    const healthy = label("healthy")
    mirrorMeta({ [META.status]: "stopped" }, "healthy")

    const { accounts } = await read()
    expect(accounts).toEqual([
      {
        label: "corrupt",
        login: "logged in",
        service: "failed",
        connected_at: null,
        last_received_at: null,
        refreshed_at: null,
        chats: null,
        followed: null,
        messages: null,
        error: "the mirror cannot be read",
        action: "check_service",
        hint: "Check the sync service's status and log to find why it failed.",
      },
      expect.objectContaining({
        label: "healthy",
        service: "stopped",
        action: "start_service",
      }),
    ])
    expect(existsSync(`${corrupt.mirror}-wal`)).toBe(false)
    expect(existsSync(`${corrupt.mirror}-shm`)).toBe(false)
    expect(existsSync(`${healthy.mirror}-wal`)).toBe(false)
    expect(existsSync(`${healthy.mirror}-shm`)).toBe(false)
  })

  test("reports chat, followed chat, and message counts from the mirror", async () => {
    const paths = label()
    const mirror = openMirrorForWrite(paths.mirror)
    try {
      mirror
        .prepare("INSERT INTO chats (id, kind, updated, followed) VALUES (?, 'user', ?, 1), (?, 'group', ?, 0)")
        .run("100", NOW, "200", NOW)
      mirror
        .prepare("INSERT INTO messages (chat, id, ts, received) VALUES (?, 1, ?, ?), (?, 2, ?, ?)")
        .run("100", NOW, NOW, "100", NOW + 1, NOW + 1)
    } finally {
      mirror.close()
    }
    const [account] = (await read()).accounts
    expect(account?.chats).toBe(2)
    expect(account?.followed).toBe(1)
    expect(account?.messages).toBe(2)
  })

  test("account name, id, phone-like text and message body never appear in the JSON", async () => {
    const paths = label()
    const mirror = openMirrorForWrite(paths.mirror)
    try {
      setMeta(mirror, {
        [META.status]: "stopped",
        [META.accountId]: "999888777",
        [META.accountName]: "Secret Owner",
      })
      mirror
        .prepare("INSERT INTO chats (id, kind, name, updated) VALUES (?, 'user', ?, ?)")
        .run("100", "+12025550199", NOW)
      mirror
        .prepare("INSERT INTO messages (chat, id, ts, received, body) VALUES (?, 1, ?, ?, ?)")
        .run("100", NOW, NOW, "super secret message text")
    } finally {
      mirror.close()
    }
    const json = JSON.stringify(await read())
    for (const secret of ["999888777", "Secret Owner", "+12025550199", "super secret message text"]) {
      expect(json).not.toContain(secret)
    }
  })

  test("reading leaves the mirror's mtime and size unchanged, with no WAL left behind", async () => {
    const paths = label()
    mirrorMeta({ [META.status]: "stopped" })
    expect(existsSync(`${paths.mirror}-wal`)).toBe(false)
    const before = statSync(paths.mirror)
    await read()
    const after = statSync(paths.mirror)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.size).toBe(before.size)
    expect(existsSync(`${paths.mirror}-wal`)).toBe(false)
  })
})
