import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, writeFileSync } from "node:fs"
import { writeApp } from "../core/telegram/app"
import { PROJECT } from "../project"
import { APP, harness, type Harness } from "./commands.testing"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "./command-io"
import { runLogoutCommand } from "./logout"

let open: Harness[] = []

afterEach(() => {
  for (const t of open) t.close()
  open = []
})

/** A harness with a logged-in label that has a session, its app and a mirror. */
function setUp(label = "default"): Harness {
  const t = harness()
  open.push(t)
  const paths = t.addLabel(label, true)
  writeApp(paths.app, APP)
  writeFileSync(paths.mirror, "")
  return t
}

describe("runLogoutCommand", () => {
  test("ends the session at Telegram, removes it here, and keeps the mirror and the app", async () => {
    const t = setUp()

    expect(await runLogoutCommand(["--state-dir", t.stateDir], t.io)).toBe(EXIT_OK)

    expect(t.out()).toContain('Logged out "default": Telegram ended the session.')
    expect(t.out()).not.toContain("Devices")
    expect(t.err()).toBe("")
    expect(t.client.loggedOut).toBe(1)
    expect(t.client.destroyed).toBe(1)
    expect(t.built[0]).toMatchObject({ ...APP, storagePath: `${t.stateDir}/default/session.sqlite` })
    expect(existsSync(`${t.stateDir}/default/session.sqlite`)).toBe(false)
    expect(existsSync(`${t.stateDir}/default/mirror.sqlite`)).toBe(true)
    expect(existsSync(`${t.stateDir}/default/app.json`)).toBe(true)
  })

  test("when Telegram cannot be reached, removes the session anyway and says where to end it", async () => {
    const t = setUp()
    t.client.failLogOut = true

    expect(await runLogoutCommand(["--state-dir", t.stateDir], t.io)).toBe(EXIT_OK)

    expect(t.out()).toContain('Logged out "default" here, but Telegram did not end the session;')
    expect(t.out()).toContain("Settings → Devices")
    expect(existsSync(`${t.stateDir}/default/session.sqlite`)).toBe(false)
  })

  test("without readable app credentials, it still removes the session and says where to end it", async () => {
    const t = setUp()
    writeFileSync(`${t.stateDir}/default/app.json`, "{}")

    expect(await runLogoutCommand(["--state-dir", t.stateDir], t.io)).toBe(EXIT_OK)
    expect(t.out()).toContain("Settings → Devices")
    expect(t.built).toEqual([])
    expect(existsSync(`${t.stateDir}/default/session.sqlite`)).toBe(false)
  })

  test("takes the account by name", async () => {
    const t = setUp("work")
    t.addLabel("other", true)

    expect(await runLogoutCommand(["--account", "work", "--state-dir", t.stateDir], t.io)).toBe(EXIT_OK)
    expect(t.out()).toContain('"work"')
    expect(existsSync(`${t.stateDir}/other/session.sqlite`)).toBe(true)
  })

  test("refuses a label that is not logged in, and while the service runs", async () => {
    const t = harness()
    open.push(t)
    t.addLabel("default")
    expect(await runLogoutCommand(["--state-dir", t.stateDir], t.io)).toBe(EXIT_FAILED)
    expect(t.err()).toBe(`${PROJECT.cli}: This account is not logged in.\n`)

    const running = setUp()
    writeFileSync(`${running.stateDir}/default/sync.lock`, `${process.ppid}\n`)
    expect(await runLogoutCommand(["--state-dir", running.stateDir], running.io)).toBe(EXIT_USAGE)
    expect(running.err()).toContain("sync service for this label is running")
    expect(running.client.loggedOut).toBe(0)
    expect(existsSync(`${running.stateDir}/default/session.sqlite`)).toBe(true)
  })

  test("several accounts need a name, and a mistake in the command line is a usage error", async () => {
    const t = setUp("one")
    t.addLabel("two", true)
    expect(await runLogoutCommand(["--state-dir", t.stateDir], t.io)).toBe(EXIT_USAGE)
    expect(await runLogoutCommand(["--state-dir", t.stateDir, "--bogus"], t.io)).toBe(EXIT_USAGE)
    expect(await runLogoutCommand(["--state-dir", t.stateDir, "--account"], t.io)).toBe(EXIT_USAGE)
  })
})
