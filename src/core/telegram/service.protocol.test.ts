import { afterEach, describe, expect, test } from "bun:test"
import { connect, type Socket } from "node:net"
import { callService } from "./service"
import { MAX_REQUEST_LINE_LENGTH } from "./service-lines"
import type { ServeOptions, ServiceHandler } from "./service-server"
import { startTestService, type TestService } from "./service.testing"

let service: TestService | undefined
const sockets: Socket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy()
  await service?.close()
  service = undefined
})

/** Connects as a raw client and resolves with the lines the service sends, each parsed, as they arrive. */
async function rawClient(
  handlers: Record<string, ServiceHandler> = { ping: async () => "pong", id: async (params) => params },
  options?: ServeOptions,
) {
  service = await startTestService(handlers, options)
  const socket = connect(service.socketPath)
  sockets.push(socket)
  socket.setEncoding("utf8")
  const replies: unknown[] = []
  let buffer = ""
  let closed = false
  socket.on("data", (chunk: string) => {
    buffer += chunk
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) replies.push(JSON.parse(line))
  })
  socket.on("close", () => (closed = true))
  socket.on("error", () => {})
  await new Promise<void>((resolve) => socket.once("connect", resolve))
  return {
    send: (text: string) => socket.write(text),
    hangUp: () => socket.destroy(),
    replies,
    isClosed: () => closed,
    /** Waits until `count` replies have arrived. */
    async waitFor(count: number) {
      for (let waited = 0; replies.length < count && waited < 2_000; waited += 10) await Bun.sleep(10)
      return replies
    },
  }
}

const errorReply = (id: unknown, code: number) => ({ jsonrpc: "2.0", id, error: { code, message: expect.any(String) } })

describe("requests the server cannot take", () => {
  test("a line that is not JSON gets -32700 with a null id, and the connection stays", async () => {
    const client = await rawClient()
    client.send("this is not json\n")
    client.send('{"jsonrpc":"2.0","id":1,"method":"ping"}\n')
    expect(await client.waitFor(2)).toEqual([errorReply(null, -32700), { jsonrpc: "2.0", id: 1, result: "pong" }])
  })

  test("a request that is not valid gets -32600, with its id when it has a usable one", async () => {
    const client = await rawClient()
    client.send('{"id":7,"method":"ping"}\n')
    client.send('{"jsonrpc":"2.0","id":8,"method":5}\n')
    client.send('{"jsonrpc":"2.0","id":9,"method":"ping","params":"text"}\n')
    client.send('{"jsonrpc":"2.0","id":[1],"method":"ping"}\n')
    client.send("[1]\n")
    expect(await client.waitFor(5)).toEqual([
      errorReply(7, -32600),
      errorReply(8, -32600),
      errorReply(9, -32600),
      errorReply(null, -32600),
      errorReply(null, -32600),
    ])
  })

  test("an unknown method gets -32601 with the request's id", async () => {
    const client = await rawClient()
    client.send('{"jsonrpc":"2.0","id":"a","method":"nope"}\n')
    expect(await client.waitFor(1)).toEqual([errorReply("a", -32601)])
  })

  test("a notification is ignored, a blank line too, and string ids are echoed", async () => {
    const client = await rawClient()
    client.send('\n{"jsonrpc":"2.0","method":"ping"}\n{"jsonrpc":"2.0","method":"nope"}\n')
    client.send('{"jsonrpc":"2.0","id":"x","method":"id","params":[1]}\n')
    expect(await client.waitFor(1)).toEqual([{ jsonrpc: "2.0", id: "x", result: [1] }])
    await Bun.sleep(30)
    expect(client.replies).toHaveLength(1)
  })

  test("a line over the limit gets -32600 and the connection is closed", async () => {
    const client = await rawClient()
    client.send("x".repeat(MAX_REQUEST_LINE_LENGTH + 1))
    expect(await client.waitFor(1)).toEqual([errorReply(null, -32600)])
    for (let waited = 0; !client.isClosed() && waited < 2_000; waited += 10) await Bun.sleep(10)
    expect(client.isClosed()).toBe(true)
  })

  test("a line at the limit is taken", async () => {
    const client = await rawClient()
    const head = '{"jsonrpc":"2.0","id":1,"method":"id","params":["'
    const tail = '"]}'
    const padding = "y".repeat(MAX_REQUEST_LINE_LENGTH - head.length - tail.length)
    client.send(`${head}${padding}${tail}\n`)
    expect(await client.waitFor(1)).toEqual([{ jsonrpc: "2.0", id: 1, result: [padding] }])
  })
})

describe("a service that runs for long", () => {
  const events: unknown[] = []
  const record = (event: unknown) => events.push(event)

  afterEach(() => {
    process.off("unhandledRejection", record)
    process.off("uncaughtException", record)
    events.length = 0
  })

  test("lets no rejection or exception escape, whoever fails or hangs up", async () => {
    process.on("unhandledRejection", record)
    process.on("uncaughtException", record)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    let observed = 0
    const client = await rawClient(
      {
        throws: async () => {
          throw new Error("boom")
        },
        late: async () => {
          await gate
          return "late"
        },
        lateThrows: async () => {
          await gate
          throw new Error("boom late")
        },
      },
      {
        onError: () => {
          observed++
          if (observed === 1) throw new Error("observer threw")
          if (observed === 2) return Promise.reject(new Error("observer rejected")) as never
        },
      },
    )

    client.send('{"jsonrpc":"2.0","id":1,"method":"throws"}\n{"jsonrpc":"2.0","id":2,"method":"throws"}\n')
    expect(await client.waitFor(2)).toMatchObject([{ error: { data: { code: "internal_error" } } }, { id: 2 }])

    client.send('{"jsonrpc":"2.0","id":3,"method":"late"}\n{"jsonrpc":"2.0","id":4,"method":"lateThrows"}\nnot json\n')
    await Bun.sleep(30)
    client.hangUp()
    await Bun.sleep(30)
    release()
    await Bun.sleep(100)

    expect(observed).toBe(3)
    expect(events).toEqual([])
    expect(await callService(service!.socketPath, "late", {}, { effect: "read" })).toBe("late")
  })
})
