import { afterEach, describe, expect, test } from "bun:test"
import { listLabels } from "../core/telegram/labels"
import { PROJECT } from "../project"
import { fakeHost, harness, type Harness } from "./commands.testing"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CommandIo } from "./command-io"
import { runRemoveCommand } from "./remove"

let open: Harness[] = []

afterEach(() => {
  for (const t of open) t.close()
  open = []
})

function setUp(overrides: Partial<CommandIo> = {}, loggedIn = false): Harness {
  const t = harness(overrides)
  open.push(t)
  t.addLabel("work", loggedIn)
  return t
}

describe("runRemoveCommand", () => {
  test("requires --account", async () => {
    const t = setUp()
    expect(await runRemoveCommand(["--state-dir", t.stateDir], t.io)).toBe(EXIT_USAGE)
    expect(t.err()).toBe(`${PROJECT.cli}: Option --account is required.\n`)
  })

  test("refuses without --yes when there is no terminal", async () => {
    const t = setUp({ isTTY: false })

    expect(await runRemoveCommand(["--account", "work", "--state-dir", t.stateDir], t.io)).toBe(EXIT_USAGE)
    expect(t.err()).toBe(`${PROJECT.cli}: Removing an account without a terminal requires --yes.\n`)
    expect(await listLabels(t.stateDir)).toEqual(["work"])
  })

  test("removes after the label is typed on a terminal", async () => {
    let asked = ""
    const t = setUp({
      readLine: async (prompt) => ((asked = prompt), "work"),
    })

    expect(await runRemoveCommand(["--account", "work", "--state-dir", t.stateDir], t.io)).toBe(EXIT_OK)
    expect(asked).toContain('To confirm, please type the label name "work": ')
    expect(t.out()).toContain('Removed "work".')
    expect(t.err()).toBe("")
    expect(await listLabels(t.stateDir)).toEqual([])
  })

  test("cancels on a mismatch and deletes nothing", async () => {
    const t = setUp({ readLine: async () => "wrong" })

    expect(await runRemoveCommand(["--account", "work", "--state-dir", t.stateDir], t.io)).toBe(EXIT_FAILED)
    expect(t.err()).toBe(`${PROJECT.cli}: Removal cancelled.\n`)
    expect(await listLabels(t.stateDir)).toEqual(["work"])
  })

  test("--yes removes a label that was never logged in, without mentioning Devices", async () => {
    const t = setUp({ isTTY: false })

    expect(await runRemoveCommand(["--account", "work", "--yes", "--state-dir", t.stateDir], t.io)).toBe(EXIT_OK)
    expect(t.out()).toBe('Removed "work".\n')
    expect(t.host.ran.length).toBeGreaterThan(0)
    expect(await listLabels(t.stateDir)).toEqual([])
  })

  test("reminds to end a logged-in label's session under Settings → Devices", async () => {
    const t = setUp({ isTTY: false }, true)

    expect(await runRemoveCommand(["--account", "work", "--yes", "--state-dir", t.stateDir], t.io)).toBe(EXIT_OK)
    expect(t.out()).toContain('Removed "work".')
    expect(t.out()).toContain("end the session in Telegram under Settings → Devices")
  })

  test("deletes nothing when the service cannot be uninstalled", async () => {
    const t = setUp({ isTTY: false })
    t.io.serviceHost = fakeHost(t.stateDir, {
      run: async () => ({ code: 1, stdout: "", stderr: "launchctl bootout: Operation not permitted" }),
    })

    expect(await runRemoveCommand(["--account", "work", "--yes", "--state-dir", t.stateDir], t.io)).toBe(EXIT_FAILED)
    expect(t.err()).toContain("launchctl")
    expect(await listLabels(t.stateDir)).toEqual(["work"])
  })

  test("goes on where services are not supported", async () => {
    const t = setUp({ isTTY: false })
    t.io.serviceHost = fakeHost(t.stateDir, { platform: "win32" })

    expect(await runRemoveCommand(["--account", "work", "--yes", "--state-dir", t.stateDir], t.io)).toBe(EXIT_OK)
    expect(await listLabels(t.stateDir)).toEqual([])
  })

  test("an unknown label is not found", async () => {
    const t = setUp({ isTTY: false })
    expect(await runRemoveCommand(["--account", "nobody", "--yes", "--state-dir", t.stateDir], t.io)).toBe(EXIT_FAILED)
    expect(t.err()).toContain('"nobody" was not found')
  })
})
