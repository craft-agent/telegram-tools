import { connect } from "node:net"
import { afterEach, describe, expect, test } from "bun:test"
import { ToolError } from "../errors"
import { callService } from "./service"
import { serveService, type ServiceCall, type ServiceServer } from "./service-server"
import { eventually } from "./sync.testing"
import { failureOf, tempSocketPath } from "./service.testing"

const REPEATS = 25

let socket: ReturnType<typeof tempSocketPath>
let server: ServiceServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  socket.remove()
})

async function serve(handler: (call: ServiceCall) => Promise<unknown>): Promise<string> {
  socket = tempSocketPath()
  server = await serveService(socket.socketPath, { work: (_params, call) => handler(call) })
  return socket.socketPath
}

describe("an effect that waits for the answer", () => {
  test("lets the answer reach the client although the effect closes the service", async () => {
    const path = await serve(async (call) => {
      call.afterAnswered?.(() => void server?.close())
      return "done"
    })

    expect(await callService(path, "work", {}, { effect: "write" })).toBe("done")
  })

  test("does so every time, however the answer and the closing happen to be timed", async () => {
    for (let run = 0; run < REPEATS; run++) {
      const path = await serve(async (call) => {
        if (run % 2) await new Promise((resolve) => setTimeout(resolve, run % 5))
        call.afterAnswered?.(() => void server?.close())
        return { run }
      })

      expect(await callService(path, "work", {}, { effect: "write" })).toEqual({ run })
      await server?.close()
      socket.remove()
    }
  })

  test("lets the error reach the client too", async () => {
    const path = await serve(async (call) => {
      call.afterAnswered?.(() => void server?.close())
      throw new ToolError("upstream_error", "made-up failure")
    })

    expect(await failureOf(callService(path, "work", {}, { effect: "read" }))).toMatchObject({
      code: "upstream_error",
      message: "made-up failure",
    })
  })

  test("does not run before the handler has returned, and runs once after", async () => {
    let ran = 0
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const path = await serve(async (call) => {
      call.afterAnswered?.(() => void ran++)
      await gate
      return "late"
    })

    const answer = callService(path, "work", {}, { effect: "read" })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(ran).toBe(0)

    release()
    expect(await answer).toBe("late")
    await eventually(() => ran === 1)
  })

  test("runs at once when asked for after the answer was written", async () => {
    let held: ServiceCall | undefined
    const path = await serve(async (call) => void (held = call))

    await callService(path, "work", {}, { effect: "read" })
    let ran = false
    held?.afterAnswered?.(() => void (ran = true))

    expect(ran).toBe(true)
  })

  test("runs when the client is gone and no answer can be written", async () => {
    let ran = 0
    const path = await serve(async (call) => {
      call.afterAnswered?.(() => void ran++)
      await new Promise((resolve) => call.signal.addEventListener("abort", resolve, { once: true }))
      return "unheard"
    })

    const client = connect(path)
    client.on("error", () => {})
    client.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "work", params: {} })}\n`)
    await new Promise((resolve) => setTimeout(resolve, 30))
    client.destroy()

    await eventually(() => ran === 1)
  })

  test("a failing effect does not take the service down", async () => {
    const path = await serve(async (call) => {
      call.afterAnswered?.(() => {
        throw new Error("the effect failed")
      })
      return "fine"
    })

    expect(await callService(path, "work", {}, { effect: "read" })).toBe("fine")
    expect(await callService(path, "work", {}, { effect: "read" })).toBe("fine")
  })
})
