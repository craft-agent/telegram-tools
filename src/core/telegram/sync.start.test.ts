import { afterEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { FAKE_IDS } from "./fake-telegram.testing"
import { setMeta } from "./mirror"
import { rpcError } from "./login.testing"
import { rowsOf } from "./mirror.testing"
import { callService } from "./service"
import { SESSION_ENDED_ERRORS } from "./rpc-errors"
import { LOCK_HELD_REASON } from "./sync-lock"
import { START_MS, syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture
let holder: ChildProcess | undefined

afterEach(async () => {
  holder?.kill("SIGKILL")
  holder = undefined
  await fixture.close()
})

/** Writes values into the label's mirror before the service runs. */
function seedMirror(values: Record<string, string | number>): void {
  fixture.seed((mirror) => setMeta(mirror, values))
}

describe("runSync when there is nothing to run", () => {
  test("a label without a directory is not logged in and nothing is created", async () => {
    fixture = syncFixture()

    const outcome = await fixture.run({ label: "elsewhere" })

    expect(outcome).toEqual({ exitCode: 0, status: "not logged in" })
    expect(existsSync(join(fixture.stateDir, "elsewhere"))).toBe(false)
    expect(fixture.client.calls).toEqual([])
  })

  test("a label directory without a session is not logged in and gets no mirror and no lock", async () => {
    fixture = syncFixture()
    rmSync(fixture.paths.session)

    const outcome = await fixture.run()

    expect(outcome).toEqual({ exitCode: 0, status: "not logged in" })
    expect(existsSync(fixture.paths.mirror)).toBe(false)
    expect(existsSync(fixture.paths.syncLock)).toBe(false)
    expect(fixture.client.calls).toEqual([])
  })

  test("a session without the app's credentials asks to log in first, without a client", async () => {
    fixture = syncFixture()
    rmSync(fixture.paths.app)

    const outcome = await fixture.run()

    expect(outcome).toEqual({ exitCode: 0, status: "not logged in" })
    expect(fixture.logs.at(-1)).toContain("log in first")
    expect(fixture.client.calls).toEqual([])
    expect(existsSync(fixture.paths.syncLock)).toBe(false)
  })

  test("app credentials that cannot be read fail the run and say so in the mirror", async () => {
    fixture = syncFixture()
    writeFileSync(fixture.paths.app, "not json")

    const outcome = await fixture.run()

    expect(outcome.exitCode).toBe(1)
    expect(outcome.status).toBe("failed")
    expect(fixture.meta()).toMatchObject({ status: "failed" })
    expect(fixture.client.calls).toEqual([])
  })

  test("a lock held by another process fails the run at once, touching nothing", async () => {
    fixture = syncFixture()
    holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    writeFileSync(fixture.paths.syncLock, `${holder.pid}\n`)

    const outcome = await fixture.run()

    expect(outcome).toEqual({ exitCode: 1, status: "failed", reason: LOCK_HELD_REASON })
    expect(readFileSync(fixture.paths.syncLock, "utf8")).toBe(`${holder.pid}\n`)
    expect(existsSync(fixture.paths.mirror)).toBe(false)
    expect(fixture.client.calls).toEqual([])
  })
})

describe("runSync starting", () => {
  test("a mirror of another account is refused and left as it was", async () => {
    fixture = syncFixture()
    seedMirror({ account_id: "42" })

    const outcome = await fixture.run()

    expect(outcome).toEqual({ exitCode: 1, status: "failed", reason: "this mirror belongs to another account" })
    expect(fixture.meta()).toMatchObject({ status: "failed", account_id: "42" })
    expect(fixture.client.argsOf("startUpdatesLoop")).toEqual([])
    expect(fixture.client.destroyed).toBe(true)
  })

  test("a mirror of this account is taken over", async () => {
    fixture = syncFixture()
    seedMirror({ account_id: String(FAKE_IDS.me), error: "left over" })

    const { stop } = await fixture.running()
    stop()

    expect(fixture.meta()).toMatchObject({ account_id: String(FAKE_IDS.me), status: "running" })
    expect(fixture.meta().error).toBeUndefined()
  })

  for (const name of SESSION_ENDED_ERRORS) {
    test(`${name} is a session Telegram ended: logged out, exit 0`, async () => {
      fixture = syncFixture()
      fixture.client.fail("getMe", rpcError(401, name))

      const outcome = await fixture.run()

      expect(outcome).toEqual({
        exitCode: 0,
        status: "logged out",
        reason: "Telegram ended this session; log in again",
      })
      expect(fixture.meta()).toMatchObject({ status: "logged out", error: "Telegram ended this session; log in again" })
      expect(fixture.client.destroyed).toBe(true)
      expect(existsSync(fixture.paths.socket)).toBe(false)
    })
  }

  test("any other failure to connect fails the run with Telegram's name for it", async () => {
    fixture = syncFixture()
    fixture.client.fail("connect", rpcError(500, "NETWORK_MIGRATE_X"))

    const outcome = await fixture.run()

    expect(outcome).toEqual({ exitCode: 1, status: "failed", reason: "Telegram answered NETWORK_MIGRATE_X" })
    expect(fixture.meta()).toMatchObject({ status: "failed", error: "Telegram answered NETWORK_MIGRATE_X" })
  })

  test("every handler is in place before the client connects and before its updates start", async () => {
    fixture = syncFixture()

    const { stop } = await fixture.running()
    stop()

    const registered = { onNewMessage: 1, onEditMessage: 1, onDeleteMessage: 1, onHistoryRead: 1, onError: 1 }
    expect(fixture.client.listenersAtConnect).toEqual(registered)
    expect(fixture.client.listenersAtStart).toEqual(registered)
    const order = fixture.client.calls.map((call) => call.method)
    expect(order.slice(0, 3)).toEqual(["connect", "getMe", "startUpdatesLoop"])
  })

  test("records the account, the times and the running status", async () => {
    fixture = syncFixture()

    const { stop, outcome } = await fixture.running()
    const meta = fixture.meta()
    stop()
    await outcome

    expect(meta).toMatchObject({
      status: "running",
      account_id: String(FAKE_IDS.me),
      account_name: "Me Example",
      started_at: String(START_MS),
      connected_at: String(START_MS),
    })
    expect(meta.error).toBeUndefined()
  })

  test("the time since the last beat of the run before is a gap in watching; a first start has none", async () => {
    fixture = syncFixture()
    const first = await fixture.running()
    first.stop()
    await first.outcome
    expect(fixture.mirror((m) => rowsOf(m, "SELECT start FROM gaps"))).toEqual([])

    fixture.clock.advance(120_000)
    seedMirror({ alive_at: START_MS + 1_000 })
    const second = await fixture.running()
    second.stop()
    await second.outcome

    expect(fixture.mirror((m) => rowsOf(m, "SELECT start, until FROM gaps"))).toEqual([
      { start: START_MS + 1_000, until: START_MS + 120_000 },
    ])
  })
})

describe("runSync's socket", () => {
  test("answers status with the connection, since when, and the account's id", async () => {
    fixture = syncFixture()
    const { stop } = await fixture.running()

    const up = await callService(fixture.paths.socket, "status", undefined, { effect: "read" })
    fixture.client.drop()
    const down = await callService(fixture.paths.socket, "status", undefined, { effect: "read" })
    fixture.clock.advance(5_000)
    fixture.client.regain()
    const back = await callService(fixture.paths.socket, "status", undefined, { effect: "read" })
    stop()

    const account = String(FAKE_IDS.me)
    expect(up).toEqual({ connected: true, since: START_MS, account })
    expect(down).toEqual({ connected: false, since: null, account })
    expect(back).toEqual({ connected: true, since: START_MS + 5_000, account })
  })

  test("is private to its owner and answers no other method", async () => {
    fixture = syncFixture()
    const { stop } = await fixture.running()

    const unknown = callService(fixture.paths.socket, "history", undefined, { effect: "read" })

    await expect(unknown).rejects.toThrow()
    expect(statSync(fixture.paths.socket).mode & 0o777).toBe(0o600)
    stop()
  })
})
