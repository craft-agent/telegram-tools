import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { UNCERTAIN_ADVICE } from "./service-errors"
import { callService, ServiceConnection, type CallEffect } from "./service"
import {
  failureOf,
  leaveStaleSocket,
  startFakeService,
  tempSocketPath,
  type FakeReply,
  type FakeService,
} from "./service.testing"

const SHORT_MS = 200
const MAX_LINE = 1024
const NOT_RUNNING = "The sync service is not running at this account's socket. Start it and try again."
const EFFECTS: CallEffect[] = ["read", "write"]

let service: FakeService | undefined
const cleanups: (() => void)[] = []

afterEach(async () => {
  await service?.close()
  service = undefined
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function call(reply: FakeReply, effect: CallEffect, extra: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  service = await startFakeService(() => reply)
  return failureOf(callService(service.socketPath, "send", {}, { effect, timeoutMs: SHORT_MS, ...extra }))
}

describe("a service that is not there", () => {
  for (const effect of EFFECTS) {
    test(`is upstream_error for a ${effect} without the path or the OS text: nothing was sent`, async () => {
      const path = join(tmpdir(), "tg-missing-dir", "s")
      const error = await failureOf(callService(path, "send", {}, { effect }))
      expect(error).toMatchObject({ code: "upstream_error" })
      expect(error.message).toBe(NOT_RUNNING)
      expect(error.message).not.toContain("tg-missing-dir")
    })

    test(`is the same for a ${effect} on a socket file nothing answers on`, async () => {
      const socket = tempSocketPath()
      cleanups.push(socket.remove)
      await leaveStaleSocket(socket.socketPath)
      const error = await failureOf(callService(socket.socketPath, "send", {}, { effect }))
      expect(error).toMatchObject({ code: "upstream_error", message: NOT_RUNNING })
    })
  }

  test("aborts before connecting", async () => {
    service = await startFakeService(() => ({ result: 1 }))
    const error = await failureOf(ServiceConnection.connect(service.socketPath, { signal: AbortSignal.abort() }))
    expect(error.name).toBe("AbortError")
    expect(service.calls).toEqual([])
  })

  for (const effect of EFFECTS) {
    test(`aborts a ${effect} that has not started`, async () => {
      service = await startFakeService(() => ({ result: 1 }))
      const error = await failureOf(
        callService(service.socketPath, "send", {}, { effect, signal: AbortSignal.abort() }),
      )
      expect(error.name).toBe("AbortError")
      expect(service.calls).toEqual([])
    })
  }
})

describe("time limits", () => {
  test("a read that times out is upstream_error", async () => {
    const error = await call("hang", "read")
    expect(error).toMatchObject({ code: "upstream_error" })
    expect(error.message).toContain("send")
  })

  test("a write that times out is uncertain", async () => {
    const error = await call("hang", "write")
    expect(error).toMatchObject({ code: "uncertain" })
    expect(error.message).toContain(UNCERTAIN_ADVICE)
  })

  test("an answer that comes after the limit is ignored", async () => {
    service = await startFakeService(async () => {
      await new Promise((resolve) => setTimeout(resolve, SHORT_MS * 2))
      return { result: 1 }
    })
    const connection = await ServiceConnection.connect(service.socketPath)
    const error = await failureOf(connection.call("send", {}, { effect: "read", timeoutMs: 50 }))
    expect(error).toMatchObject({ code: "upstream_error" })
    await new Promise((resolve) => setTimeout(resolve, SHORT_MS * 2))
    connection.close()
  })
})

describe("a service that hangs up mid-call", () => {
  test("is upstream_error for a read", async () => {
    expect(await call("close", "read")).toMatchObject({ code: "upstream_error" })
  })

  test("is uncertain for a write", async () => {
    expect(await call("close", "write")).toMatchObject({ code: "uncertain" })
  })

  test("settles `closed` and the calls in flight when the client closes", async () => {
    service = await startFakeService(() => "hang")
    const connection = await ServiceConnection.connect(service.socketPath)
    const read = connection.call("listChats", {}, { effect: "read", timeoutMs: 5_000 })
    const write = connection.call("send", {}, { effect: "write", timeoutMs: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    connection.close()
    expect(await failureOf(read)).toMatchObject({ code: "upstream_error" })
    expect(await failureOf(write)).toMatchObject({ code: "uncertain" })
    await connection.closed
  })

  test("rejects a call on a connection that is closed, as not sent", async () => {
    service = await startFakeService(() => ({ result: 1 }))
    const connection = await ServiceConnection.connect(service.socketPath)
    connection.close()
    const error = await failureOf(connection.call("send", {}, { effect: "write" }))
    expect(error).toMatchObject({ code: "upstream_error" })
    expect(error.message).toContain("was not sent")
    await connection.closed
  })
})

describe("cancellation after the request was written", () => {
  test("is an abort error for a read", async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const error = await call("hang", "read", { timeoutMs: 5_000, signal: controller.signal })
    expect(error.name).toBe("AbortError")
  })

  test("is uncertain for a write", async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const error = await call("hang", "write", { timeoutMs: 5_000, signal: controller.signal })
    expect(error).toMatchObject({ name: "ToolError", code: "uncertain" })
  })
})

describe("a service that breaks the protocol", () => {
  for (const effect of EFFECTS) {
    test(`a line that is not JSON ends the connection: ${effect === "write" ? "uncertain" : "upstream_error"} for a ${effect}`, async () => {
      service = await startFakeService(() => "hang")
      const connection = await ServiceConnection.connect(service.socketPath)
      const pending = connection.call("send", {}, { effect, timeoutMs: 5_000 })
      await new Promise((resolve) => setTimeout(resolve, 50))
      service.sendRaw("this is not json\n")
      expect(await failureOf(pending)).toMatchObject({ code: effect === "write" ? "uncertain" : "upstream_error" })
      await connection.closed
    })
  }

  test("a JSON line that is not an object ends the connection too", async () => {
    service = await startFakeService(() => "hang")
    const connection = await ServiceConnection.connect(service.socketPath)
    const pending = connection.call("send", {}, { effect: "write", timeoutMs: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    service.sendRaw("[1]\n")
    expect(await failureOf(pending)).toMatchObject({ code: "uncertain" })
    await connection.closed
  })

  test("blank lines, answers to ids nobody asked and replies without an id are ignored", async () => {
    const reply =
      '\n\n{"jsonrpc":"2.0","id":999,"result":"stray"}\n{"jsonrpc":"2.0","id":"x","result":1}\n{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"x"}}\n'
    service = await startFakeService((method) => {
      service?.sendRaw(reply)
      return { result: method }
    })
    expect(await callService(service.socketPath, "first", {}, { effect: "write" })).toBe("first")
  })

  describe("a reply to a pending call whose envelope is malformed", () => {
    const malformed: [string, string][] = [
      ["has no jsonrpc", '{"id":1,"result":"x"}'],
      ["has another jsonrpc version", '{"jsonrpc":"1.0","id":1,"result":"x"}'],
      ["has both result and error", '{"jsonrpc":"2.0","id":1,"result":"x","error":{"code":-1,"message":"m"}}'],
      ["has neither result nor error", '{"jsonrpc":"2.0","id":1}'],
      ["has an error without a code", '{"jsonrpc":"2.0","id":1,"error":{"message":"m"}}'],
      ["has an error with a code that is not a number", '{"jsonrpc":"2.0","id":1,"error":{"code":"-1","message":"m"}}'],
      ["has an error without a message", '{"jsonrpc":"2.0","id":1,"error":{"code":-1}}'],
      ["has an error that is not an object", '{"jsonrpc":"2.0","id":1,"error":"boom"}'],
    ]
    for (const [name, line] of malformed) {
      for (const effect of EFFECTS) {
        test(`${name} is ${effect === "write" ? "uncertain" : "upstream_error"} for a ${effect}, and the connection stays`, async () => {
          service = await startFakeService(() => "hang")
          const connection = await ServiceConnection.connect(service.socketPath)
          const pending = connection.call("send", {}, { effect, timeoutMs: 5_000 })
          await new Promise((resolve) => setTimeout(resolve, 50))
          service.sendRaw(`${line}\n`)
          const error = await failureOf(pending)
          expect(error).toMatchObject({ name: "ToolError", code: effect === "write" ? "uncertain" : "upstream_error" })
          expect(error.message).toContain("the service answered it malformed")
          if (effect === "write") expect(error.message).toContain(UNCERTAIN_ADVICE)
          const next = connection.call("send", {}, { effect: "read", timeoutMs: SHORT_MS })
          await new Promise((resolve) => setTimeout(resolve, 50))
          service.sendRaw('{"jsonrpc":"2.0","id":2,"result":"fine"}\n')
          expect(await next).toBe("fine")
          connection.close()
        })
      }
    }

    test("one for an id nobody waits for is ignored", async () => {
      service = await startFakeService(() => "hang")
      const connection = await ServiceConnection.connect(service.socketPath)
      const pending = connection.call("send", {}, { effect: "write", timeoutMs: 5_000 })
      await new Promise((resolve) => setTimeout(resolve, 50))
      service.sendRaw('{"id":999,"result":"x"}\n{"jsonrpc":"2.0","id":998}\n{"jsonrpc":"2.0","id":1,"result":"ok"}\n')
      expect(await pending).toBe("ok")
      connection.close()
    })
  })

  test("a line over the limit ends the connection, and a line within it does not", async () => {
    service = await startFakeService(() => "hang")
    const connection = await ServiceConnection.connect(service.socketPath, { maxLineLength: MAX_LINE })
    const pending = connection.call("send", {}, { effect: "write", timeoutMs: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    service.sendRaw(`${JSON.stringify({ jsonrpc: "2.0", id: 999, result: "y".repeat(MAX_LINE / 2) })}\n`)
    await new Promise((resolve) => setTimeout(resolve, 50))
    service.sendRaw(Buffer.alloc(MAX_LINE + 1, "x"))
    expect(await failureOf(pending)).toMatchObject({ code: "uncertain" })
    await connection.closed
  })

  test("a reply read in pieces, multibyte characters included, is one reply", async () => {
    service = await startFakeService(() => "hang")
    const connection = await ServiceConnection.connect(service.socketPath)
    const pending = connection.call("send", {}, { effect: "read", timeoutMs: 5_000 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const bytes = Buffer.from('{"jsonrpc":"2.0","id":1,"result":"é"}\n')
    const cut = bytes.indexOf(0xc3) + 1
    service.sendRaw(bytes.subarray(0, cut))
    await new Promise((resolve) => setTimeout(resolve, 20))
    service.sendRaw(bytes.subarray(cut))
    expect(await pending).toBe("é")
    connection.close()
  })
})
