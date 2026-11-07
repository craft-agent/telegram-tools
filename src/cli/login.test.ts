import { afterEach, describe, expect, test } from "bun:test"
import { serializeTelethonSession } from "@mtcute/convert"
import { randomBytes } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { ALREADY_LOGGED_IN } from "../core/telegram/login"
import { fakeAccount, fakeSentCode, floodWait, rpcError } from "../core/telegram/login.testing"
import { PROJECT } from "../project"
import { APP, ENV_APP, harness, type Harness } from "./commands.testing"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CommandIo } from "./command-io"
import { runLogin } from "./login"

const QR_URL = "tg://login?token=abc"
const NOT_LOGGED_IN = rpcError(401, "AUTH_KEY_UNREGISTERED")
const NAME = fakeAccount().displayName
const PHONE = "+15550100123"

let open: Harness[] = []

afterEach(() => {
  for (const t of open) t.close()
  open = []
})

/** Answers a prompt reader from a list, in order. */
function answers(list: string[]): NonNullable<CommandIo["readLine"]> {
  const rest = [...list]
  return async () => rest.shift()
}

function setUp(overrides: Partial<CommandIo> = {}): Harness {
  const t = harness({ env: ENV_APP, ...overrides })
  open.push(t)
  return t
}

/** Makes the fake client show one QR URL while signing in. */
function qrLogin(t: Harness) {
  t.client.script("getMe", NOT_LOGGED_IN).script("signInQr", (params: { onUrlUpdated: (url: string) => void }) => {
    params.onUrlUpdated(QR_URL)
    return fakeAccount()
  })
}

describe("runLogin", () => {
  test("logs in by QR code by default, prints the next steps, and closes the client", async () => {
    const t = setUp()
    qrLogin(t)

    const code = await runLogin(["--state-dir", t.stateDir], t.io)

    expect(code).toBe(EXIT_OK)
    expect(t.out()).toContain("Telegram > Settings > Devices")
    expect(t.out()).toMatch(/\x1b\[4[07]m/)
    expect(t.out()).not.toContain(QR_URL)
    expect(t.out()).toContain(`Logged in as ${NAME}.`)
    expect(t.out()).toContain(`${PROJECT.cli} service install --account default`)
    expect(t.out()).toContain(`${PROJECT.cli} sync --account default`)
    expect(t.err()).toBe("")
    expect(t.client.destroyed).toBe(1)
    expect(t.built).toHaveLength(1)
    expect(t.built[0]?.storagePath).toBe(`${t.stateDir}/default/session.sqlite`)
    expect(t.built[0]?.device.model).toBe(`${PROJECT.name} (unofficial)`)
    expect(t.built[0]?.device.appVersion).toBe("0.0.0-dev")
    expect(t.built[0]?.device.systemVersion).toMatch(/\S+ \S+/)
  })

  test("takes the label from --account", async () => {
    const t = setUp()
    qrLogin(t)

    expect(await runLogin(["--account=work", "--state-dir", t.stateDir], t.io)).toBe(EXIT_OK)
    expect(t.built[0]?.storagePath).toBe(`${t.stateDir}/work/session.sqlite`)
    expect(t.out()).toContain("service install --account work")
  })

  test("--phone asks for the number and the code, and prints the number nowhere", async () => {
    const t = setUp({ readLine: answers([PHONE, "12345"]) })
    t.client.script("getMe", NOT_LOGGED_IN).script("sendCode", fakeSentCode()).script("signIn", fakeAccount())

    const code = await runLogin(["--phone", "--state-dir", t.stateDir], t.io)

    expect(code).toBe(EXIT_OK)
    expect(t.out()).toContain(`Logged in as ${NAME}.`)
    expect(t.out() + t.err()).not.toContain(PHONE)
    expect(t.client.argsOf("sendCode")).toHaveLength(1)
    expect(t.client.argsOf("signInQr")).toHaveLength(0)
  })

  describe("--telethon", () => {
    const session = serializeTelethonSession({
      dcId: 2,
      ipAddress: "127.0.0.2",
      ipv6: false,
      port: 443,
      authKey: new Uint8Array(randomBytes(256)),
    })

    function telethonClient(t: Harness) {
      t.client.script("getMe", NOT_LOGGED_IN, fakeAccount()).script("importSession", undefined)
    }

    test("reads the string without echo on a terminal", async () => {
      const t = setUp({ readHidden: answers([session]) })
      telethonClient(t)

      expect(await runLogin(["--telethon", "--state-dir", t.stateDir], t.io)).toBe(EXIT_OK)
      expect(t.client.argsOf("importSession")).toHaveLength(1)
      expect(t.out() + t.err()).not.toContain(session)
    })

    test("reads the string from standard input without a terminal", async () => {
      const t = setUp({ isTTY: false, readStdin: async () => `${session}\n` })
      telethonClient(t)

      expect(await runLogin(["--telethon", "--state-dir", t.stateDir], t.io)).toBe(EXIT_OK)
      expect(t.client.argsOf("importSession")).toHaveLength(1)
    })

    test("an empty standard input is a usage error", async () => {
      const t = setUp({ isTTY: false, readStdin: async () => "  \n" })
      t.client.script("getMe", NOT_LOGGED_IN)

      expect(await runLogin(["--telethon", "--state-dir", t.stateDir], t.io)).toBe(EXIT_FAILED)
      expect(t.err()).toContain("No Telethon string session")
    })
  })

  test("--phone and --telethon together are a usage error", async () => {
    const t = setUp()
    expect(await runLogin(["--phone", "--telethon", "--state-dir", t.stateDir], t.io)).toBe(EXIT_USAGE)
    expect(t.err()).toContain("cannot be used together")
    expect(t.built).toEqual([])
  })

  test("refuses while the label's sync service runs, touching nothing", async () => {
    const t = setUp()
    const paths = t.addLabel("default")
    writeFileSync(paths.syncLock, `${process.ppid}\n`)

    expect(await runLogin(["--state-dir", t.stateDir], t.io)).toBe(EXIT_FAILED)
    expect(t.err()).toContain("The sync service for this label is running; stop it first")
    expect(t.built).toEqual([])
  })

  test("refuses before asking for any credential when the lock is held", async () => {
    const asked: string[] = []
    const t = setUp({
      env: {},
      readLine: async (prompt) => void asked.push(prompt),
      readHidden: async (prompt) => void asked.push(prompt),
    })
    const paths = t.addLabel("default")
    writeFileSync(paths.syncLock, `${process.ppid}\n`)

    expect(await runLogin(["--state-dir", t.stateDir], t.io)).toBe(EXIT_FAILED)
    expect(t.err()).toContain("The sync service for this label is running; stop it first")
    expect(asked).toEqual([])
    expect(t.out()).toBe("")
  })

  test("says so when the label is already logged in, and keeps its session", async () => {
    const t = setUp()
    const paths = t.addLabel("default", true)
    t.client.script("getMe", fakeAccount())

    expect(await runLogin(["--state-dir", t.stateDir], t.io)).toBe(EXIT_FAILED)
    expect(t.err()).toBe(`${PROJECT.cli}: ${ALREADY_LOGGED_IN}\n`)
    expect(existsSync(paths.session)).toBe(true)
    expect(t.client.destroyed).toBe(1)
    expect(t.client.argsOf("signInQr")).toHaveLength(0)
  })

  test("removes the session files of a failed first login, and closes the client", async () => {
    const t = setUp({ readLine: answers([PHONE, "00000"]) })
    const paths = t.addLabel("default")
    for (const suffix of ["", "-wal", "-shm"]) writeFileSync(`${paths.session}${suffix}`, "half")
    t.client
      .script("getMe", NOT_LOGGED_IN)
      .script("sendCode", fakeSentCode())
      .script("signIn", rpcError(400, "PHONE_CODE_EXPIRED"))

    expect(await runLogin(["--phone", "--state-dir", t.stateDir], t.io)).toBe(EXIT_FAILED)
    for (const suffix of ["", "-wal", "-shm"]) expect(existsSync(`${paths.session}${suffix}`)).toBe(false)
    expect(t.err()).toContain("The code expired")
    expect(t.out() + t.err()).not.toContain(PHONE)
    expect(t.client.destroyed).toBe(1)
  })

  test("keeps the session when the logged-in check itself fails", async () => {
    for (const failure of [rpcError(500, "INTERNAL"), floodWait(30)]) {
      const t = setUp()
      const paths = t.addLabel("default", true)
      t.client.script("getMe", failure)

      expect(await runLogin(["--state-dir", t.stateDir], t.io)).toBe(EXIT_FAILED)
      expect(t.err()).not.toBe("")
      expect(existsSync(paths.session)).toBe(true)
      expect(t.client.destroyed).toBe(1)
    }
  })

  test("holds the lock during the run and releases it afterwards", async () => {
    const t = setUp()
    const paths = t.addLabel("default")
    let held: string | undefined
    t.client.script("getMe", NOT_LOGGED_IN).script("signInQr", () => {
      held = readFileSync(paths.syncLock, "utf8")
      return fakeAccount()
    })

    expect(await runLogin(["--state-dir", t.stateDir], t.io)).toBe(EXIT_OK)
    expect(held).toBe(`${process.pid}\n`)
    expect(existsSync(paths.syncLock)).toBe(false)
  })

  test("reports a cancellation", async () => {
    const t = setUp({ signal: AbortSignal.abort() })
    t.client.script("getMe", NOT_LOGGED_IN).script("signInQr", new DOMException("aborted", "AbortError"))

    expect(await runLogin(["--state-dir", t.stateDir], t.io)).toBe(EXIT_FAILED)
    expect(t.err()).toBe(`${PROJECT.cli}: Login was cancelled.\n`)
  })

  test("a mistake in the command line is one line on standard error and exit 2", async () => {
    for (const args of [
      ["--account"],
      ["--account", "Bad Label"],
      ["--phone=1"],
      ["--bogus"],
      ["extra"],
      ["--read-only"],
    ]) {
      const t = setUp()
      expect(await runLogin(["--state-dir", t.stateDir, ...args], t.io)).toBe(EXIT_USAGE)
      expect(t.out()).toBe("")
      expect(t.err()).toMatch(new RegExp(`^${PROJECT.cli}: [^\\n]+\\n$`))
      expect(t.built).toEqual([])
    }
  })

  test("the app credentials are kept for the next run", async () => {
    const t = setUp()
    qrLogin(t)
    await runLogin(["--state-dir", t.stateDir], t.io)
    expect(t.built[0]).toMatchObject(APP)
  })
})
