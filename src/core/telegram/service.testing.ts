import { mkdtempSync, renameSync, rmSync } from "node:fs"
import { createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serveService, type ServeOptions, type ServiceHandler, type ServiceServer } from "./service-server"

/** What the scripted service does with a request: answer it, never answer, or hang up. */
export type FakeReply =
  { result: unknown } | { error: { code: number; message: string; data?: unknown } } | "hang" | "close"

export type FakeService = {
  socketPath: string
  /** Every request received, in order. */
  calls: { method: string; params: unknown }[]
  /** Sends data as it is, without a line break added, to every connected client. */
  sendRaw(data: string | Uint8Array): void
  /** Closes the server and its clients and removes the socket's directory. */
  close(): Promise<void>
}

export type TestService = ServiceServer & { socketPath: string }

/** A fresh, short temp directory: a socket path must stay under the 103-byte limit. */
function shortTempDir(): string {
  return mkdtempSync(join(tmpdir(), "tg-"))
}

/** The error a promise rejects with, for a test that checks it; fails when the promise resolves. */
export async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error("expected the promise to reject")
}

/** A path for a socket in a fresh temp directory; `remove()` deletes the directory. */
export function tempSocketPath(): { socketPath: string; remove(): void } {
  const dir = shortTempDir()
  return { socketPath: join(dir, "s"), remove: () => rmSync(dir, { recursive: true, force: true }) }
}

/** The real `serveService` on a temp socket; `close()` also removes the socket's directory. */
export async function startTestService(
  handlers: Record<string, ServiceHandler>,
  options?: ServeOptions,
): Promise<TestService> {
  const { socketPath, remove } = tempSocketPath()
  const server = await serveService(socketPath, handlers, options)
  return {
    socketPath,
    async close() {
      await server.close()
      remove()
    },
  }
}

/** Leaves a socket file at `socketPath` that nothing listens on, as a service killed without cleaning up does. */
export async function leaveStaleSocket(socketPath: string): Promise<void> {
  const moved = `${socketPath}.moved`
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  renameSync(socketPath, moved)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  renameSync(moved, socketPath)
}

/** A scripted service on a UNIX socket in a fresh, short temp directory, for replies the real server never gives. */
export async function startFakeService(
  reply: (method: string, params: unknown) => FakeReply | Promise<FakeReply>,
): Promise<FakeService> {
  const { socketPath, remove } = tempSocketPath()
  const clients = new Set<Socket>()
  const calls: FakeService["calls"] = []

  const answer = async (client: Socket, line: string) => {
    const request = JSON.parse(line) as { id: number; method: string; params?: unknown }
    calls.push({ method: request.method, params: request.params })
    const outcome = await reply(request.method, request.params)
    if (outcome === "hang") return
    if (outcome === "close") {
      client.destroy()
      return
    }
    client.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...outcome })}\n`)
  }

  const server = createServer((client) => {
    clients.add(client)
    client.setEncoding("utf8")
    client.on("error", () => {})
    client.on("close", () => clients.delete(client))
    let buffer = ""
    client.on("data", (chunk: string) => {
      buffer += chunk
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) if (line.trim()) void answer(client, line)
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))

  return {
    socketPath,
    calls,
    sendRaw(data) {
      for (const client of clients) client.write(data)
    },
    async close() {
      for (const client of clients) client.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      remove()
    },
  }
}
