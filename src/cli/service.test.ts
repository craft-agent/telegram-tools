import { afterEach, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { PROJECT } from "../project"
import { fakeHost, harness, type Harness } from "./commands.testing"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CommandIo } from "./command-io"
import { SERVICE_ID, runServiceCommand } from "./service"

const SELF = { program: "/bin/node", script: "/bin/cli.js" }

let open: Harness[] = []

afterEach(() => {
  for (const t of open) t.close()
  open = []
})

function setUp(overrides: Partial<CommandIo> = {}): Harness {
  const t = harness({ self: SELF, ...overrides })
  open.push(t)
  return t
}

/** The text of every file the service host wrote under the home directory. */
function unitText(home: string): string {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
    )
  return files(join(home, "Library", "LaunchAgents"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n")
}

describe("service install", () => {
  test("installs the unit for the only logged-in label with the sync arguments", async () => {
    const t = setUp()
    t.addLabel("default", true)

    expect(await runServiceCommand(["install", "--state-dir", t.stateDir], t.io)).toBe(EXIT_OK)

    expect(t.out()).toContain('Installed sync service for "default"')
    expect(t.err()).toBe("")
    const unit = unitText(t.stateDir)
    expect(unit).toContain(SERVICE_ID)
    expect(unit).toContain(SELF.program)
    for (const arg of [SELF.script, "sync", "--account", "default", "--state-dir", t.stateDir]) {
      expect(unit).toContain(`<string>${arg}</string>`)
    }
    expect(unit).not.toContain("--keep-disappearing")
    expect(unit).not.toContain("--channels")
  })

  test("bakes --keep-disappearing and --channels into the unit when on", async () => {
    const t = setUp()
    t.addLabel("default", true)
    await runServiceCommand(["install", "--keep-disappearing", "--channels", "--state-dir", t.stateDir], t.io)
    expect(unitText(t.stateDir)).toContain("<string>--keep-disappearing</string>")
    expect(unitText(t.stateDir)).toContain("<string>--channels</string>")

    const fromEnv = setUp({ env: { TELEGRAM_TOOLS_CHANNELS: "true" } })
    fromEnv.addLabel("default", true)
    await runServiceCommand(["install", "--state-dir", fromEnv.stateDir], fromEnv.io)
    expect(unitText(fromEnv.stateDir)).toContain("<string>--channels</string>")
    expect(unitText(fromEnv.stateDir)).not.toContain("--keep-disappearing")
  })

  test("installs anyway while sync runs in the foreground, with a warning", async () => {
    const t = setUp()
    const paths = t.addLabel("default", true)
    writeFileSync(paths.syncLock, `${process.ppid}\n`)

    expect(await runServiceCommand(["install", "--state-dir", t.stateDir], t.io)).toBe(EXIT_OK)

    expect(t.out()).toContain(`Warning: ${PROJECT.cli} sync is running in the foreground`)
    expect(t.out()).toContain("keep retrying every minute")
    expect(t.out()).toContain('Installed sync service for "default"')
    expect(unitText(t.stateDir)).toContain(SERVICE_ID)
  })

  test("prints no warning when nothing holds the lock", async () => {
    const t = setUp()
    t.addLabel("default", true)

    await runServiceCommand(["install", "--state-dir", t.stateDir], t.io)

    expect(t.out()).not.toContain("Warning")
  })

  test("refuses a label that is not logged in, naming the login command", async () => {
    const t = setUp()
    t.addLabel("work", false)

    expect(await runServiceCommand(["install", "--account", "work", "--state-dir", t.stateDir], t.io)).toBe(EXIT_FAILED)
    expect(t.err()).toBe(
      `${PROJECT.cli}: This label is not logged in; log in first with: ${PROJECT.cli} login --account work\n`,
    )
    expect(t.host.ran).toEqual([])
  })

  test("several labels need --account; none is not found", async () => {
    const several = setUp()
    several.addLabel("first", true)
    several.addLabel("second", true)
    expect(await runServiceCommand(["install", "--state-dir", several.stateDir], several.io)).toBe(EXIT_USAGE)
    expect(several.err()).toContain("first, second")

    const none = setUp()
    expect(await runServiceCommand(["install", "--state-dir", none.stateDir], none.io)).toBe(EXIT_FAILED)
    expect(none.err()).toContain("No Telegram account is logged in yet")
  })

  test("prints the lingering hint on Linux only", async () => {
    const linux = setUp()
    linux.addLabel("default", true)
    linux.io.serviceHost = fakeHost(linux.stateDir, { platform: "linux", env: { PATH: "/bin" } })
    expect(await runServiceCommand(["install", "--state-dir", linux.stateDir], linux.io)).toBe(EXIT_OK)
    expect(linux.out()).toContain("loginctl enable-linger")
    const file = /\((.+\.service)\)/.exec(linux.out())?.[1]
    const unit = readFileSync(file!, "utf8")
    expect(unit).toContain("Description=Telegram sync service")
    expect(unit).toContain("--state-dir")
  })

  test("refuses on other platforms", async () => {
    const t = setUp()
    t.addLabel("default", true)
    t.io.serviceHost = fakeHost(t.stateDir, { platform: "win32" })

    expect(await runServiceCommand(["install", "--state-dir", t.stateDir], t.io)).toBe(EXIT_FAILED)
    expect(t.err()).toContain("supported on macOS and Linux only")
  })
})

describe("service uninstall and status", () => {
  test("uninstall names the label", async () => {
    const t = setUp()
    expect(await runServiceCommand(["uninstall", "--account", "work", "--state-dir", t.stateDir], t.io)).toBe(EXIT_OK)
    expect(t.out()).toBe('Uninstalled sync service for "work".\n')
  })

  test("status reports whether it is installed and running", async () => {
    const t = setUp()
    t.addLabel("default", true)
    expect(await runServiceCommand(["status", "--state-dir", t.stateDir], t.io)).toBe(EXIT_OK)
    expect(t.out()).toContain('Sync service for "default":')
    expect(t.out()).toContain("Installed: no")
    expect(t.out()).toContain("Running: no")
  })
})

describe("service usage", () => {
  test.each([
    [[], "No service command given"],
    [["bogus"], 'Unknown service command "bogus"'],
    [["install", "--account"], "--account"],
    [["install", "--account", "Bad Label"], "Invalid label"],
    [["status", "--read-only"], "--read-only"],
    [["status", "--bogus"], "--bogus"],
  ])("%j is a usage error", async (args, message) => {
    const t = setUp()
    const argv = args.length === 0 ? [] : [...(args as string[]), "--state-dir", t.stateDir]
    expect(await runServiceCommand(argv, t.io)).toBe(EXIT_USAGE)
    expect(t.err()).toContain(message)
    expect(t.out()).toBe("")
  })
})
