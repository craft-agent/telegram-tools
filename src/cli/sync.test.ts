import { afterEach, describe, expect, test } from "bun:test"
import type { SyncOptions } from "../core/telegram/sync"
import { NOT_LOGGED_IN_MESSAGE } from "../core/telegram/sync-outcome"
import { PROJECT } from "../project"
import { APP, harness, type Harness } from "./commands.testing"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CommandIo } from "./command-io"
import { runSyncCommand } from "./sync"

const LOG_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \S/

let open: Harness[] = []

afterEach(() => {
  for (const t of open) t.close()
  open = []
})

type Call = SyncOptions

/** A harness whose `runSync` records its options and ends with `exitCode`. */
function setUp(exitCode: 0 | 1 = 0, overrides: Partial<CommandIo> = {}): Harness & { calls: Call[] } {
  const calls: Call[] = []
  const t = Object.assign(
    harness({
      async runSync(options) {
        calls.push(options)
        options.log("sync said something")
        return { exitCode, status: "stopped" }
      },
      ...overrides,
    }),
    { calls },
  )
  open.push(t)
  return t
}

describe("runSyncCommand", () => {
  test("runs the only account with the options, logging to standard error with the time", async () => {
    const controller = new AbortController()
    const t = setUp(0, { signal: controller.signal })
    t.addLabel("main", true)

    expect(await runSyncCommand(["--state-dir", t.stateDir], t.io)).toBe(EXIT_OK)

    expect(t.out()).toBe("")
    expect(t.err().trimEnd()).toMatch(LOG_LINE)
    expect(t.err()).toEndWith("sync said something\n")
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0]).toMatchObject({
      stateDir: t.stateDir,
      label: "main",
      keepDisappearing: false,
      channels: false,
      signal: controller.signal,
    })
  })

  test("passes --keep-disappearing and --channels, or their environment variables", async () => {
    const t = setUp()
    t.addLabel("main", true)
    await runSyncCommand(["--state-dir", t.stateDir, "--keep-disappearing", "--channels"], t.io)
    expect(t.calls[0]).toMatchObject({ keepDisappearing: true, channels: true })

    const fromEnv = setUp(0, { env: { TELEGRAM_TOOLS_CHANNELS: "1" } })
    fromEnv.addLabel("main", true)
    await runSyncCommand(["--state-dir", fromEnv.stateDir], fromEnv.io)
    expect(fromEnv.calls[0]).toMatchObject({ keepDisappearing: false, channels: true })
  })

  test("takes the account by name", async () => {
    const t = setUp()
    t.addLabel("main", true)
    t.addLabel("other", true)

    expect(await runSyncCommand(["--account=other", "--state-dir", t.stateDir], t.io)).toBe(EXIT_OK)
    expect(t.calls[0]?.label).toBe("other")
  })

  test("builds the client on the label's session with the app, as this command line identifies itself", async () => {
    const t = setUp()
    const paths = t.addLabel("main", true)
    await runSyncCommand(["--state-dir", t.stateDir], t.io)

    const open = t.calls[0]!.openClient
    open(APP)
    expect(t.built).toHaveLength(1)
    expect(t.built[0]).toMatchObject({ storagePath: paths.session, ...APP })
    expect(t.built[0]?.device.model).toBe(`${PROJECT.name} (unofficial)`)
  })

  test("exits with the outcome's code", async () => {
    const t = setUp(1)
    t.addLabel("main", true)
    expect(await runSyncCommand(["--state-dir", t.stateDir], t.io)).toBe(EXIT_FAILED)
  })

  test("several accounts need a name: usage error listing them", async () => {
    const t = setUp()
    t.addLabel("main", true)
    t.addLabel("other", true)

    expect(await runSyncCommand(["--state-dir", t.stateDir], t.io)).toBe(EXIT_USAGE)
    expect(t.err()).toContain("main, other")
    expect(t.calls).toEqual([])
  })

  test("no account, or an unknown one, is not logged in: exit 0 without running", async () => {
    const t = setUp()
    expect(await runSyncCommand(["--state-dir", t.stateDir], t.io)).toBe(EXIT_OK)
    expect(t.err()).toMatch(new RegExp(`Z ${NOT_LOGGED_IN_MESSAGE}\\n$`))

    t.addLabel("main", true)
    expect(await runSyncCommand(["--account", "nobody", "--state-dir", t.stateDir], t.io)).toBe(EXIT_OK)
    expect(t.calls).toEqual([])
  })

  test("a mistake in the command line is a usage error", async () => {
    for (const args of [["--account", "Nobody"], ["--account"], ["--bogus"], ["--read-only"], ["--channels=1"]]) {
      const t = setUp()
      expect(await runSyncCommand(["--state-dir", t.stateDir, ...args], t.io)).toBe(EXIT_USAGE)
      expect(t.calls).toEqual([])
    }
  })
})
