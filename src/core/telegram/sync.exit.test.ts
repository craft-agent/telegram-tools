import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { userPeer } from "./fake-telegram.testing"
import { floodWait, rpcError } from "./login.testing"
import type { SyncOutcome } from "./sync"
import { aliceMessage, eventually, fakeDialogFor, syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeEach(() => {
  fixture = syncFixture()
})

afterEach(() => fixture.close())

const LOGGED_OUT: SyncOutcome = {
  exitCode: 0,
  status: "logged out",
  reason: "Telegram ended this session; log in again",
}
const NOT_WRITABLE = "the mirror cannot be written; receiving stopped"

/** What every end leaves behind: the client destroyed, no socket, and the lock released. */
function expectNothingLeft(): void {
  expect(fixture.client.destroyed).toBe(true)
  expect(existsSync(fixture.paths.socket)).toBe(false)
  expect(existsSync(fixture.paths.syncLock)).toBe(false)
}

describe("runSync stopping", () => {
  test("a stop request records stopped, exit 0, and leaves nothing behind", async () => {
    const { stop, outcome } = await fixture.running()
    expect(existsSync(fixture.paths.socket)).toBe(true)

    stop()

    expect(await outcome).toEqual({ exitCode: 0, status: "stopped" })
    expect(fixture.meta().status).toBe("stopped")
    expect(fixture.meta().error).toBeUndefined()
    expect(fixture.logs.at(-1)).toBe("stopped")
    expectNothingLeft()
  })

  test("a run can start again once the one before ended", async () => {
    const first = await fixture.running()
    first.stop()
    await first.outcome

    const second = await fixture.running()
    second.stop()

    expect((await second.outcome).status).toBe("stopped")
  })

  test("a stop request before anything starts never opens the client", async () => {
    const outcome = await fixture.run({ signal: AbortSignal.abort() })

    expect(outcome).toEqual({ exitCode: 0, status: "stopped" })
    expect(fixture.client.calls).toEqual([])
    expect(existsSync(fixture.paths.syncLock)).toBe(false)
  })

  test("a stop request while the client is still connecting destroys it and stops", async () => {
    fixture.client.holdConnect()
    const { stop, outcome } = fixture.start()
    await eventually(() => fixture.client.argsOf("connect").length === 1)

    stop()

    expect(await outcome).toEqual({ exitCode: 0, status: "stopped" })
    expectNothingLeft()
  })

  test("a client that never finishes being destroyed does not hold the end back", async () => {
    fixture.client.destroy = () => new Promise(() => {})
    const { stop, outcome } = await fixture.running({ stopWaitMs: 100 })

    stop()

    expect((await outcome).status).toBe("stopped")
    expect(existsSync(fixture.paths.syncLock)).toBe(false)
  })
})

describe("runSync when Telegram ends the session", () => {
  test("an error the client reports is logged out, exit 0, and the service stays down", async () => {
    const { outcome } = await fixture.running()

    fixture.client.onError.emit(rpcError(401, "AUTH_KEY_UNREGISTERED"))

    expect(await outcome).toEqual(LOGGED_OUT)
    expect(fixture.meta()).toMatchObject({ status: "logged out", error: LOGGED_OUT.reason })
    expectNothingLeft()
  })

  test("an error from the chat list is logged out too", async () => {
    fixture.client.fail("iterDialogs", rpcError(401, "USER_DEACTIVATED_BAN"))

    expect(await fixture.run()).toEqual(LOGGED_OUT)
    expectNothingLeft()
  })

  test("an error from a background fetch is logged out too", async () => {
    fixture.client.setDialogs(fakeDialogFor(userPeer(), 3))
    fixture.client.fail("getHistory", rpcError(401, "SESSION_REVOKED"))

    expect(await fixture.run()).toEqual(LOGGED_OUT)
    expectNothingLeft()
  })

  test("any other error the client reports is logged by its name and the service goes on", async () => {
    const { stop } = await fixture.running()

    fixture.client.onError.emit(new Error("a detail that must stay out of the log"))
    fixture.client.onError.emit(rpcError(500, "INTERDC_CALL_ERROR"))

    expect(fixture.logs).toContain("client error: Error")
    expect(fixture.logs).toContain("client error: INTERDC_CALL_ERROR")
    expect(fixture.logs.join("\n")).not.toContain("detail")
    expect(fixture.meta().status).toBe("running")
    stop()
  })

  test("a flood wait from Telegram is not an end", async () => {
    fixture.client.setDialogs(fakeDialogFor(userPeer(), 3))
    fixture.client.fail("getHistory", floodWait(5))
    const { stop } = await fixture.running()

    await eventually(() => fixture.logs.includes("seeding: flood wait of 5 seconds"))

    expect(fixture.meta().status).toBe("running")
    stop()
  })
})

describe("runSync when it cannot go on", () => {
  test("a mirror that cannot be written while receiving fails the run, exit 1, and stops storing", async () => {
    const { outcome } = await fixture.running()
    fixture.seed((mirror) => mirror.exec("DROP TABLE messages"))

    fixture.client.onNewMessage.emit(aliceMessage(1))
    fixture.client.onNewMessage.emit(aliceMessage(2))

    expect(await outcome).toEqual({ exitCode: 1, status: "failed", reason: NOT_WRITABLE })
    expect(fixture.meta()).toMatchObject({ status: "failed", error: NOT_WRITABLE })
    expect(fixture.logs.filter((line) => line === NOT_WRITABLE)).toHaveLength(1)
    expectNothingLeft()
  })

  test("a mirror that cannot be written by the upkeep fails the run too", async () => {
    const { outcome } = await fixture.running({ heartbeatEveryMs: 50 })

    fixture.seed((mirror) => mirror.exec("DROP TABLE meta"))

    expect(await outcome).toEqual({ exitCode: 1, status: "failed", reason: NOT_WRITABLE })
    expectNothingLeft()
  })

  test("a connection down for longer than the limit fails the run so that its supervisor restarts it", async () => {
    const { outcome } = await fixture.running({ offlineLimitMs: 5_000 })

    fixture.client.drop()
    fixture.clock.advance(6_000)

    expect(await outcome).toEqual({
      exitCode: 1,
      status: "failed",
      reason: "the connection to Telegram could not be kept",
    })
    expect(fixture.meta().status).toBe("failed")
    expectNothingLeft()
  })

  test("a connection that comes back within the limit keeps the run going", async () => {
    const { stop } = await fixture.running({ offlineLimitMs: 5_000 })

    fixture.client.drop()
    fixture.clock.advance(4_000)
    fixture.client.regain()
    fixture.clock.advance(4_000)
    await eventually(() => fixture.meta().alive_at === String(fixture.clock.now))

    expect(fixture.meta().status).toBe("running")
    stop()
  })
})
