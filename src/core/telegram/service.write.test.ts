import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { getEventListeners } from "node:events"
import { Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { UNCERTAIN_ADVICE } from "./service-errors"
import { MAX_REQUEST_LINE_LENGTH } from "./service-lines"
import { callService, ServiceConnection } from "./service"
import { failureOf, startFakeService, type FakeService } from "./service.testing"

const NOT_RUNNING = "The sync service is not running at this account's socket. Start it and try again."

let service: FakeService | undefined
let restoreTimers: (() => void) | undefined

afterEach(async () => {
  restoreTimers?.()
  restoreTimers = undefined
  await service?.close()
  service = undefined
})

/** Watches the timers set from now on; `leaked()` lists those never cleared, which would keep a process alive. */
function trackTimers() {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const created: unknown[] = []
  const cleared = new Set<unknown>()
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const timer = realSet(...args)
    created.push(timer)
    return timer
  }) as typeof setTimeout
  globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => {
    cleared.add(timer)
    realClear(timer)
  }) as typeof clearTimeout
  restoreTimers = () => {
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
  }
  return { created: () => created.length, leaked: () => created.filter((timer) => !cleared.has(timer)) }
}

async function connect() {
  service = await startFakeService(() => ({ result: "ok" }))
  const connection = await ServiceConnection.connect(service.socketPath)
  return { service, connection, socket: connection["socket"], pending: connection["pending"] }
}

describe("a request that cannot be written", () => {
  test("an argument JSON cannot hold is invalid_argument, and nothing is registered or sent", async () => {
    const { service, connection, pending } = await connect()
    const timers = trackTimers()
    const controller = new AbortController()
    const error = await failureOf(
      connection.call("send", { size: 10n }, { effect: "write", signal: controller.signal }),
    )
    expect(error).toMatchObject({ name: "ToolError", code: "invalid_argument" })
    expect(error.message).toContain("send")
    expect(timers.created()).toBe(0)
    expect(pending.size).toBe(0)
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
    expect(service.calls).toEqual([])
    expect(await connection.call("version", undefined, { effect: "read" })).toBe("ok")
    connection.close()
  })

  for (const effect of ["read", "write"] as const) {
    test(`a request over the service's line limit is invalid_argument for a ${effect}, and nothing is written`, async () => {
      const { service, connection, pending } = await connect()
      const timers = trackTimers()
      const controller = new AbortController()
      const error = await failureOf(
        connection.call("send", { text: "x".repeat(MAX_REQUEST_LINE_LENGTH) }, { effect, signal: controller.signal }),
      )
      expect(error).toMatchObject({ name: "ToolError", code: "invalid_argument" })
      expect(error.message).toBe("The send request is too large for the service.")
      expect(timers.created()).toBe(0)
      expect(pending.size).toBe(0)
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
      expect(service.calls).toEqual([])
      expect(await connection.call("version", undefined, { effect: "read" })).toBe("ok")
      connection.close()
    })

    test(`a request exactly at the limit is written for a ${effect}`, async () => {
      const { service, connection } = await connect()
      const empty = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "send", params: { text: "" } })
      const text = "x".repeat(MAX_REQUEST_LINE_LENGTH - empty.length)
      expect(await connection.call("send", { text }, { effect })).toBe("ok")
      expect(service.calls).toEqual([{ method: "send", params: { text } }])
      connection.close()
    })
  }

  for (const [name, fail] of [
    ["a failed write callback", (cb: (error?: Error | null) => void) => cb(new Error("EPIPE"))],
    [
      "a synchronous throw from write",
      () => {
        throw new Error("write exploded")
      },
    ],
  ] as const) {
    describe(name, () => {
      test("is uncertain for a write, and leaves no timer, listener or pending call", async () => {
        const { connection, socket, pending } = await connect()
        socket.write = ((_data: unknown, cb: (error?: Error | null) => void) => {
          fail(cb)
          return false
        }) as typeof socket.write
        const timers = trackTimers()
        const controller = new AbortController()
        const error = await failureOf(connection.call("send", {}, { effect: "write", signal: controller.signal }))
        expect(error).toMatchObject({ name: "ToolError", code: "uncertain" })
        expect(error.message).toContain("send")
        expect(error.message).toContain(UNCERTAIN_ADVICE)
        expect(timers.created()).toBe(1)
        expect(timers.leaked()).toEqual([])
        expect(pending.size).toBe(0)
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
        connection.close()
      })

      test("is upstream_error for a read", async () => {
        const { connection, socket } = await connect()
        socket.write = ((_data: unknown, cb: (error?: Error | null) => void) => {
          fail(cb)
          return false
        }) as typeof socket.write
        const error = await failureOf(connection.call("listChats", undefined, { effect: "read" }))
        expect(error).toMatchObject({ name: "ToolError", code: "upstream_error" })
        connection.close()
      })
    })
  }
})

describe("connecting", () => {
  test("a synchronous throw from connect is the not-running upstream_error, with nothing left behind", async () => {
    const connectSpy = spyOn(Socket.prototype, "connect").mockImplementation(() => {
      throw new Error("connect exploded")
    })
    try {
      const path = join(tmpdir(), "tg-missing-dir", "s")
      const timers = trackTimers()
      const controller = new AbortController()
      const error = await failureOf(ServiceConnection.connect(path, { signal: controller.signal }))
      expect(error).toMatchObject({ code: "upstream_error" })
      expect(error.message).toBe(NOT_RUNNING)
      expect(timers.leaked()).toEqual([])
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)

      const viaCall = await failureOf(callService(path, "send", {}, { effect: "write" }))
      expect(viaCall).toMatchObject({ code: "upstream_error" })
    } finally {
      connectSpy.mockRestore()
    }
  })
})
