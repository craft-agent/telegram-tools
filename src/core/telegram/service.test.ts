import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { ToolError } from "../errors"
import { callService, ServiceConnection } from "./service"
import { UNCERTAIN_ADVICE } from "./service-errors"
import { serveService, type ServiceHandler } from "./service-server"
import { failureOf, leaveStaleSocket, startTestService, tempSocketPath, type TestService } from "./service.testing"

let service: TestService | undefined
const connections: ServiceConnection[] = []
const cleanups: (() => void)[] = []

afterEach(async () => {
  for (const connection of connections.splice(0)) connection.close()
  await service?.close()
  service = undefined
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function start(handlers: Record<string, ServiceHandler>, onError?: (error: unknown, method: string) => void) {
  service = await startTestService(handlers, { onError })
  return service.socketPath
}

async function connect(socketPath: string) {
  const connection = await ServiceConnection.connect(socketPath)
  connections.push(connection)
  return connection
}

describe("a call through the server", () => {
  test("returns the handler's result, and passes the params through", async () => {
    const path = await start({ echo: async (params) => ({ got: params }) })
    expect(await callService(path, "echo", { chat: "123", nested: { n: [1, 2] } }, { effect: "read" })).toEqual({
      got: { chat: "123", nested: { n: [1, 2] } },
    })
  })

  test("gives the handler no params when there are none, and null for an undefined result", async () => {
    const seen: unknown[] = []
    const path = await start({
      nothing: async (params) => {
        seen.push(params)
      },
    })
    expect(await callService(path, "nothing", undefined, { effect: "read" })).toBeNull()
    expect(seen).toEqual([undefined])
  })

  test("answers concurrent calls on one connection by id, whatever order they finish in", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const path = await start({
      slow: async () => {
        await gate
        return "slow"
      },
      fast: async () => "fast",
    })
    const connection = await connect(path)
    const slow = connection.call("slow", undefined, { effect: "read" })
    const fast = connection.call("fast", undefined, { effect: "read" })
    expect(await fast).toBe("fast")
    release()
    expect(await slow).toBe("slow")
  })
})

describe("a handler that fails", () => {
  test("a ToolError reaches the client with its code and message", async () => {
    const path = await start({
      missing: async () => {
        throw new ToolError("not_found", "No such chat.")
      },
      sent: async () => {
        throw new ToolError("uncertain", "The send may have gone out.")
      },
    })
    expect(await failureOf(callService(path, "missing", {}, { effect: "read" }))).toMatchObject({
      name: "ToolError",
      code: "not_found",
      message: "No such chat.",
    })
    expect(await failureOf(callService(path, "sent", {}, { effect: "write" }))).toMatchObject({
      code: "uncertain",
      message: "The send may have gone out.",
    })
  })

  test("any other throw reaches the client as a generic internal_error, and the observer only", async () => {
    const seen: [unknown, string][] = []
    const failure = new Error("secret detail at /private/path")
    const path = await start(
      {
        broken: async () => {
          throw failure
        },
        brokenSync: () => {
          throw failure
        },
      },
      (error, method) => seen.push([error, method]),
    )
    for (const method of ["broken", "brokenSync"]) {
      const error = await failureOf(callService(path, method, {}, { effect: "read" }))
      expect(error).toMatchObject({ code: "internal_error", message: `the service failed on ${method}` })
    }
    expect(seen).toEqual([
      [failure, "broken"],
      [failure, "brokenSync"],
    ])
  })

  test("a write whose handler throws a plain Error is uncertain, a read internal_error", async () => {
    const path = await start({
      send: async () => {
        throw new Error("secret detail at /private/path")
      },
      big: async () => ({ n: 10n }),
    })
    const error = await failureOf(callService(path, "send", {}, { effect: "write" }))
    expect(error).toMatchObject({ name: "ToolError", code: "uncertain" })
    expect(error.message).toBe(`send may have taken effect (the service failed on it). ${UNCERTAIN_ADVICE}`)
    expect(error.message).not.toContain("secret")
    expect(await failureOf(callService(path, "send", {}, { effect: "read" }))).toMatchObject({
      code: "internal_error",
    })
    expect(await failureOf(callService(path, "big", {}, { effect: "write" }))).toMatchObject({ code: "uncertain" })
  })

  test("a write whose handler throws another ToolError keeps its code", async () => {
    const path = await start({
      send: async () => {
        throw new ToolError("forbidden", "You cannot write here.")
      },
    })
    expect(await failureOf(callService(path, "send", {}, { effect: "write" }))).toMatchObject({
      code: "forbidden",
      message: "You cannot write here.",
    })
  })

  test("the client is still answered when the observer throws", async () => {
    const path = await start(
      {
        broken: async () => {
          throw new Error("boom")
        },
      },
      () => {
        throw new Error("observer failed")
      },
    )
    expect(await failureOf(callService(path, "broken", {}, { effect: "read" }))).toMatchObject({
      code: "internal_error",
    })
  })

  test("a result JSON cannot hold is an internal_error too", async () => {
    const path = await start({ big: async () => ({ n: 10n }) })
    expect(await failureOf(callService(path, "big", {}, { effect: "read" }))).toMatchObject({
      code: "internal_error",
    })
  })

  test("an unknown method is upstream_error, including names every object has", async () => {
    const path = await start({ known: async () => 1 })
    for (const method of ["frobnicate", "constructor", "toString"]) {
      const error = await failureOf(callService(path, method, {}, { effect: "write" }))
      expect(error).toMatchObject({ code: "upstream_error" })
      expect(error.message).toContain(`does not know ${method}`)
    }
  })
})

describe("disconnecting and closing", () => {
  test("a client that disconnects aborts the signal of its call in flight", async () => {
    let aborted: (() => void) | undefined
    const reached = new Promise<void>((resolve) => (aborted = resolve))
    let started: () => void = () => {}
    const running = new Promise<void>((resolve) => (started = resolve))
    const path = await start({
      wait: (_params, { signal }) => {
        signal.addEventListener("abort", () => aborted?.(), { once: true })
        started()
        return new Promise(() => {})
      },
    })
    const connection = await connect(path)
    void connection.call("wait", undefined, { effect: "read" }).catch(() => {})
    await running
    connection.close()
    await reached
  })

  test("close aborts the calls in flight, removes the socket file and stops listening", async () => {
    let signalSeen: AbortSignal | undefined
    let started: () => void = () => {}
    const running = new Promise<void>((resolve) => (started = resolve))
    const path = await start({
      wait: (_params, { signal }) => {
        signalSeen = signal
        started()
        return new Promise(() => {})
      },
    })
    const connection = await connect(path)
    const pending = failureOf(connection.call("wait", undefined, { effect: "read" }))
    await running
    await service?.close()
    expect(signalSeen?.aborted).toBe(true)
    expect(existsSync(path)).toBe(false)
    expect(await pending).toMatchObject({ code: "upstream_error" })
    expect(await failureOf(callService(path, "wait", {}, { effect: "read" }))).toMatchObject({
      code: "upstream_error",
    })
  })
})

describe("the socket file", () => {
  test("is readable and writable by its owner only", async () => {
    const path = await start({})
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test("close can be called again, also at the same time, and removes the file once", async () => {
    const socket = tempSocketPath()
    cleanups.push(socket.remove)
    const server = await serveService(socket.socketPath, {})
    await Promise.all([server.close(), server.close()])
    expect(existsSync(socket.socketPath)).toBe(false)
    writeFileSync(socket.socketPath, "put there after the close")
    await server.close()
    expect(readFileSync(socket.socketPath, "utf8")).toBe("put there after the close")
  })

  test("a stale file nothing answers on is replaced", async () => {
    const socket = tempSocketPath()
    cleanups.push(socket.remove)
    await leaveStaleSocket(socket.socketPath)
    expect(existsSync(socket.socketPath)).toBe(true)
    const server = await serveService(socket.socketPath, { ping: async () => "pong" })
    try {
      expect(await callService(socket.socketPath, "ping", {}, { effect: "read" })).toBe("pong")
    } finally {
      await server.close()
    }
  })

  test("a live service is refused, and keeps answering", async () => {
    const path = await start({ ping: async () => "pong" })
    const error = await failureOf(serveService(path, { other: async () => "other" }))
    expect(error).toMatchObject({ name: "ToolError", code: "upstream_error" })
    expect(error.message).toBe("Another sync service already listens at this account's socket.")
    expect(error.message).not.toContain(path)
    expect(await callService(path, "ping", {}, { effect: "read" })).toBe("pong")
  })

  test("a file that is not a socket is left alone, and the service does not start", async () => {
    const socket = tempSocketPath()
    cleanups.push(socket.remove)
    writeFileSync(socket.socketPath, "not a socket")
    const error = await failureOf(serveService(socket.socketPath, {}))
    expect(error).toMatchObject({ name: "ToolError", code: "internal_error" })
    expect(error.message).not.toContain(socket.socketPath)
    expect(existsSync(socket.socketPath)).toBe(true)
  })
})
