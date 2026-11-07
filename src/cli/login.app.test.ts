import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, statSync } from "node:fs"
import { readApp, writeApp } from "../core/telegram/app"
import { labelPaths } from "../core/telegram/labels"
import { fakeAccount, rpcError } from "../core/telegram/login.testing"
import { APP, ENV_APP, harness, type Harness } from "./commands.testing"
import { EXIT_FAILED, EXIT_OK, type CommandIo } from "./command-io"
import { runLogin } from "./login"

const OTHER_HASH = "fedcba9876543210fedcba9876543210"
const OTHER_ID = 654321

let open: Harness[] = []

afterEach(() => {
  for (const t of open) t.close()
  open = []
})

function setUp(overrides: Partial<CommandIo> = {}): Harness {
  const t = harness(overrides)
  open.push(t)
  t.client.script("getMe", rpcError(401, "AUTH_KEY_UNREGISTERED")).script("signInQr", fakeAccount())
  return t
}

const appPath = (t: Harness) => labelPaths(t.stateDir, "default").app

describe("runLogin app credentials", () => {
  test("come from the environment when both are set, and are saved with mode 0600", async () => {
    const t = setUp({ env: ENV_APP })

    expect(await runLogin(["--state-dir", t.stateDir], t.io)).toBe(EXIT_OK)
    expect(t.built[0]).toMatchObject(APP)
    expect(readApp(appPath(t))).toEqual(APP)
    expect(statSync(appPath(t)).mode & 0o777).toBe(0o600)
  })

  test("the environment wins over the saved ones, which it replaces", async () => {
    const t = setUp({ env: { TELEGRAM_TOOLS_API_ID: String(OTHER_ID), TELEGRAM_TOOLS_API_HASH: OTHER_HASH } })
    writeApp(t.addLabel("default").app, APP)

    expect(await runLogin(["--state-dir", t.stateDir], t.io)).toBe(EXIT_OK)
    expect(t.built[0]).toMatchObject({ apiId: OTHER_ID, apiHash: OTHER_HASH })
    expect(readApp(appPath(t))).toEqual({ apiId: OTHER_ID, apiHash: OTHER_HASH })
  })

  test("come from the saved app.json without asking, when the environment names none", async () => {
    const t = setUp({
      readLine: async () => {
        throw new Error("must not ask")
      },
    })
    writeApp(t.addLabel("default").app, APP)

    expect(await runLogin(["--state-dir", t.stateDir], t.io)).toBe(EXIT_OK)
    expect(t.built[0]).toMatchObject(APP)
  })

  test("are asked otherwise, the hash without echo, and saved; the hash is printed nowhere", async () => {
    const asked: { visible: string[]; hidden: string[] } = { visible: [], hidden: [] }
    const t = setUp({
      readLine: async (prompt) => (asked.visible.push(prompt), String(APP.apiId)),
      readHidden: async (prompt) => (asked.hidden.push(prompt), APP.apiHash),
    })

    expect(await runLogin(["--state-dir", t.stateDir], t.io)).toBe(EXIT_OK)
    expect(asked.visible).toEqual(["api_id: "])
    expect(asked.hidden).toEqual(["api_hash: "])
    expect(t.out() + t.err()).not.toContain(APP.apiHash)
    expect(JSON.parse(readFileSync(appPath(t), "utf8"))).toEqual({ api_id: APP.apiId, api_hash: APP.apiHash })
  })

  test("a malformed answer is rejected without echoing it, and nothing is built", async () => {
    const t = setUp({ readLine: async () => String(APP.apiId), readHidden: async () => "not-a-hash-SECRET" })

    expect(await runLogin(["--state-dir", t.stateDir], t.io)).toBe(EXIT_FAILED)
    expect(t.err()).toContain("api_hash")
    expect(t.err()).not.toContain("SECRET")
    expect(t.built).toEqual([])
  })

  test("without a terminal and without credentials, asking is refused", async () => {
    const t = setUp({ isTTY: false })

    expect(await runLogin(["--state-dir", t.stateDir], t.io)).toBe(EXIT_FAILED)
    expect(t.err()).toContain("needs a terminal")
    expect(t.built).toEqual([])
  })

  test("only one of the two variables is not enough", async () => {
    const t = setUp({ env: { TELEGRAM_TOOLS_API_ID: String(APP.apiId) }, isTTY: false })

    expect(await runLogin(["--state-dir", t.stateDir], t.io)).toBe(EXIT_FAILED)
    expect(t.built).toEqual([])
  })
})
