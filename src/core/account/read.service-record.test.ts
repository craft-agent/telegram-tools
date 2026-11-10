import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { labelPaths, type LabelPaths } from "../telegram/labels"
import { openMirrorForWrite, setMeta } from "../telegram/mirror"
import { META } from "../telegram/mirror-meta"
import { MIRROR_VERSION } from "../telegram/mirror-schema"
import { NOW, makeTempDir } from "../telegram/mirror.testing"
import { writeServiceRecord } from "../telegram/service-record"
import { invoke } from "../tool"
import { DOWNLOAD_CONTEXT } from "../tool.testing"
import { telegramAccountRead } from "./read"

const START_HINT = "Start the sync service to receive messages for this account."
const GONE_HINT =
  "The program the sync service was installed with is gone, as after an update; install the service again."
const RUNNING_GONE_HINT =
  "The sync service has not stopped, but the program it was installed with is gone, so it will not start again; install the service again."

let stateDir: string
let filesDir: string
const children: ChildProcess[] = []

beforeEach(() => {
  stateDir = makeTempDir()
  filesDir = mkdtempSync(join(tmpdir(), "service-files-"))
})

afterEach(() => {
  for (const child of children) child.kill("SIGKILL")
  children.length = 0
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(filesDir, { recursive: true, force: true })
})

function spawnLiveLockHolder(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  children.push(child)
  return child
}

function label(loggedIn = true): LabelPaths {
  const paths = labelPaths(stateDir, "default")
  mkdirSync(paths.dir)
  if (loggedIn) writeFileSync(paths.session, "")
  return paths
}

function mirrorStatus(status: string, meta: Parameters<typeof setMeta>[1] = {}) {
  const mirror = openMirrorForWrite(labelPaths(stateDir, "default").mirror)
  try {
    setMeta(mirror, { [META.status]: status, ...meta })
    mirror.exec(`PRAGMA user_version = ${MIRROR_VERSION}`)
  } finally {
    mirror.close()
  }
}

/** Writes a record whose files exist unless named in `missing`. */
async function record(paths: LabelPaths, missing: Array<"program" | "script"> = []) {
  const program = join(filesDir, "program")
  const script = join(filesDir, "script.js")
  if (!missing.includes("program")) writeFileSync(program, "")
  if (!missing.includes("script")) writeFileSync(script, "")
  await writeServiceRecord(paths, { program, script })
  return { program, script }
}

async function read() {
  const [account] = (await invoke(telegramAccountRead, {}, { cwd: stateDir, stateDir, ...DOWNLOAD_CONTEXT })).accounts
  return account
}

describe("account read: service record", () => {
  test("a record with both files present changes nothing", async () => {
    const paths = label()
    mirrorStatus("stopped")
    await record(paths)
    const account = await read()
    expect(account?.action).toBe("start_service")
    expect(account?.hint).toBe(START_HINT)
  })

  test("no record changes nothing", async () => {
    label()
    mirrorStatus("stopped")
    const account = await read()
    expect(account?.action).toBe("start_service")
    expect(account?.hint).toBe(START_HINT)
  })

  test.each<"program" | "script">(["program", "script"])("a stopped service with the %s gone", async (gone) => {
    const paths = label()
    mirrorStatus("stopped")
    await record(paths, [gone])
    const account = await read()
    expect(account?.service).toBe("stopped")
    expect(account?.action).toBe("start_service")
    expect(account?.hint).toBe(GONE_HINT)
  })

  test("a running service whose program is gone will not start again", async () => {
    const paths = label()
    mirrorStatus("running")
    writeFileSync(paths.syncLock, `${spawnLiveLockHolder().pid}\n`)
    await record(paths, ["program"])
    const account = await read()
    expect(account?.service).toBe("running")
    expect(account?.action).toBe("start_service")
    expect(account?.hint).toBe(RUNNING_GONE_HINT)
  })

  test("a running service with its files present needs nothing", async () => {
    const paths = label()
    mirrorStatus("running")
    writeFileSync(paths.syncLock, `${spawnLiveLockHolder().pid}\n`)
    await record(paths)
    const account = await read()
    expect(account?.action).toBeNull()
    expect(account?.hint).toBeNull()
  })

  test("a gone program wins over a failed service", async () => {
    const paths = label()
    mirrorStatus("failed")
    await record(paths, ["program"])
    const account = await read()
    expect(account?.service).toBe("failed")
    expect(account?.action).toBe("start_service")
    expect(account?.hint).toBe(GONE_HINT)
  })

  test("a gone program wins over a refused mirror, which a restart could not fix", async () => {
    const paths = label()
    mirrorStatus("stopped")
    const mirror = openMirrorForWrite(paths.mirror)
    try {
      mirror.exec(`PRAGMA user_version = ${MIRROR_VERSION + 1}`)
    } finally {
      mirror.close()
    }
    await record(paths, ["program"])
    const account = await read()
    expect(account?.error).not.toBeNull()
    expect(account?.action).toBe("start_service")
    expect(account?.hint).toBe(GONE_HINT)
  })

  test("a gone program wins over an unreadable mirror", async () => {
    const paths = label()
    writeFileSync(paths.mirror, "this is not a sqlite database\n")
    await record(paths, ["program"])
    const account = await read()
    expect(account?.error).toBe("the mirror cannot be read")
    expect(account?.action).toBe("start_service")
    expect(account?.hint).toBe(GONE_HINT)
  })

  test("logging in still comes first, with no session or one Telegram ended", async () => {
    const notLoggedIn = label(false)
    await record(notLoggedIn, ["program"])
    expect((await read())?.action).toBe("log_in")
    rmSync(stateDir, { recursive: true, force: true })

    stateDir = makeTempDir()
    const ended = label()
    utimesSync(ended.session, new Date(NOW - 1000), new Date(NOW - 1000))
    mirrorStatus("logged out", { [META.startedAt]: NOW })
    await record(ended, ["program"])
    const account = await read()
    expect(account?.login).toBe("logged out")
    expect(account?.action).toBe("log_in")
  })

  test("the result never contains the record's paths", async () => {
    const paths = label()
    mirrorStatus("stopped")
    const files = await record(paths, ["program"])
    const json = JSON.stringify(await read())
    for (const path of [files.program, files.script, filesDir]) expect(json).not.toContain(path)
  })
})
