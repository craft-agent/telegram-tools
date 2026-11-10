import { chmod, lstat, rm } from "node:fs/promises"
import { createServer, Socket, type Server } from "node:net"
import { ToolError, isToolError } from "../errors"
import { isRecord, RpcCode, ServiceErrorCode } from "./service-errors"
import { LineReader, MAX_REQUEST_LINE_LENGTH } from "./service-lines"

/** How long a socket file may take to answer before it is left alone, neither removed nor refused. */
const PROBE_TIMEOUT_MS = 1_000

/** The permissions of the socket file: readable and writable by its owner only. */
const SOCKET_FILE_MODE = 0o600

/** What a handler gets besides the request's params. */
export type ServiceCall = {
  /** Aborted when the client that sent the request disconnects, and when the service closes. */
  signal: AbortSignal
  /**
   * Runs `effect` once this call's answer has been written to its socket, or
   * at once when it already has been, or when the client is gone and no answer
   * can be. Whatever ends the service belongs here: closing the sockets first
   * would lose the answer. Absent when a handler is called without a connection.
   */
  afterAnswered?(effect: () => void): void
}

/** Runs `effect` once `call`'s answer is written (see `ServiceCall.afterAnswered`); at once for a call without a connection. */
export function afterAnswered(call: ServiceCall, effect: () => void): void {
  if (call.afterAnswered) call.afterAnswered(effect)
  else effect()
}

/** Answers one method: resolves with the result, or throws a `ToolError` the client receives as that code. */
export type ServiceHandler = (params: unknown, call: ServiceCall) => Promise<unknown>

export type ServeOptions = {
  /**
   * Receives every error a handler threw that is not a `ToolError`, with the
   * method it was running. The client is told only that the service failed:
   * the error's own text may hold private data.
   */
  onError?: (error: unknown, method: string) => void
}

export type ServiceServer = {
  /**
   * Stops listening, ends the connections, aborts the calls in flight and
   * removes the socket at its path, which is this service's own because one
   * lock keeps one service per label. Calling it again, also at the same time,
   * waits for the same close.
   */
  close(): Promise<void>
}

/** A request that passed validation; `id` is undefined for a notification. */
type Request = { id: string | number | undefined; method: string; params: unknown }

/** What connecting to an existing socket file made of it. */
type Probe = "answering" | "stale" | "unknown"

function isId(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number"
}

/** The request a parsed line holds, or undefined when it is not a valid JSON-RPC 2.0 request. */
function parseRequest(message: unknown): Request | undefined {
  if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") return undefined
  if (message.id !== undefined && !isId(message.id)) return undefined
  const { params } = message
  if (params !== undefined && !isRecord(params) && !Array.isArray(params)) return undefined
  return { id: message.id, method: message.method, params }
}

/** Whether something listens on an existing socket file: a refused or missing socket is `stale`. */
function probe(socketPath: string): Promise<Probe> {
  return new Promise((resolve) => {
    const socket = new Socket()
    const settle = (outcome: Probe) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(outcome)
    }
    const timer = setTimeout(() => settle("unknown"), PROBE_TIMEOUT_MS)
    socket.once("connect", () => settle("answering"))
    // Kept for good: a late error after the outcome must not be an unhandled `error` event.
    socket.on("error", (error: NodeJS.ErrnoException) =>
      settle(error.code === "ECONNREFUSED" || error.code === "ENOENT" ? "stale" : "unknown"),
    )
    socket.connect({ path: socketPath })
  })
}

/** Removes a socket file nothing answers on; refuses when a service listens there already. */
async function claimSocketPath(socketPath: string): Promise<void> {
  const file = await lstat(socketPath).catch(() => undefined)
  if (!file) return
  const outcome = file.isSocket() ? await probe(socketPath) : "unknown"
  if (outcome === "answering") {
    throw new ToolError("upstream_error", "Another sync service already listens at this account's socket.")
  }
  if (outcome === "stale") await rm(socketPath, { force: true })
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, () => {
      server.off("error", reject)
      resolve()
    })
  })
}

/** Stops listening and waits until the connections are gone; closing a server that is not listening is not an error. */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

/** The reply line for `reply`: the JSON-RPC envelope around an `id` and a `result` or an `error`. */
function frame(reply: Record<string, unknown>): string {
  return `${JSON.stringify({ jsonrpc: "2.0", ...reply })}\n`
}

/** Runs an effect that waited for an answer; its own failure is not the answer's. */
function runEffect(effect: () => void): void {
  try {
    effect()
  } catch {
    // The effect reports its own failures.
  }
}

/** One client's connection: reads its request lines and answers each by id, calls running concurrently. */
class Connection {
  private readonly socket: Socket
  private readonly handlers: Record<string, ServiceHandler>
  private readonly options: ServeOptions
  private readonly lines = new LineReader(MAX_REQUEST_LINE_LENGTH)
  private readonly calls = new AbortController()

  constructor(socket: Socket, handlers: Record<string, ServiceHandler>, options: ServeOptions) {
    this.socket = socket
    this.handlers = handlers
    this.options = options
    socket.setEncoding("utf8")
    socket.on("error", () => {})
    socket.on("close", () => this.calls.abort())
    socket.on("data", (chunk: string) => this.onData(chunk))
  }

  private onData(chunk: string): void {
    const { lines, overflow } = this.lines.push(chunk)
    // Each line is handled to its end inside `onLine`; the catch is the last guard against a detached rejection.
    for (const line of lines) this.onLine(line).catch(() => {})
    if (overflow) {
      this.socket.removeAllListeners("data")
      const error = { code: RpcCode.InvalidRequest, message: "the request line is too long" }
      this.write(frame({ id: null, error }), () => this.socket.destroy())
    }
  }

  private async onLine(line: string): Promise<void> {
    if (!line.trim()) return
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.reply({ id: null, error: { code: RpcCode.ParseError, message: "the request is not JSON" } })
      return
    }
    const request = parseRequest(message)
    if (!request) {
      const id = isRecord(message) && isId(message.id) ? message.id : null
      this.reply({ id, error: { code: RpcCode.InvalidRequest, message: "the request is not a JSON-RPC 2.0 request" } })
      return
    }
    if (request.id === undefined) return
    if (!Object.hasOwn(this.handlers, request.method)) {
      const error = { code: RpcCode.MethodNotFound, message: `unknown method ${request.method}` }
      this.reply({ id: request.id, error })
      return
    }
    await this.run(request.id, request.method, this.handlers[request.method]!, request.params)
  }

  private async run(id: string | number, method: string, handler: ServiceHandler, params: unknown): Promise<void> {
    const effects: (() => void)[] = []
    let answered = false
    const call: ServiceCall = {
      signal: this.calls.signal,
      afterAnswered: (effect) => (answered ? runEffect(effect) : void effects.push(effect)),
    }
    let text: string
    try {
      const result = await handler(params, call)
      text = frame({ id, result: result ?? null })
    } catch (error) {
      text = frame({ id, error: this.failure(error, method) })
    }
    this.write(text, () => {
      answered = true
      for (const effect of effects.splice(0)) runEffect(effect)
    })
  }

  /** The error reply for a failed handler; only a `ToolError`'s own message and code leave the service. */
  private failure(error: unknown, method: string) {
    if (isToolError(error)) return { code: ServiceErrorCode, message: error.message, data: { code: error.code } }
    try {
      // The observer's failure, thrown or rejected, is its own; the client still gets its answer.
      Promise.resolve(this.options.onError?.(error, method)).catch(() => {})
    } catch {
      // Thrown synchronously.
    }
    return { code: ServiceErrorCode, message: `the service failed on ${method}`, data: { code: "internal_error" } }
  }

  private reply(fields: Record<string, unknown>): void {
    this.write(frame(fields))
  }

  /**
   * Writes a reply line unless the client is gone; a write that fails on the
   * way is the client's loss. `onWritten` runs once the line is flushed, or
   * when it cannot be.
   */
  private write(text: string, onWritten?: () => void): void {
    if (!this.socket.writable) {
      onWritten?.()
      return
    }
    try {
      this.socket.write(text, onWritten)
    } catch {
      this.socket.destroy()
      onWritten?.()
    }
  }
}

/**
 * Starts the sync service's socket server at `socketPath`, answering each
 * request with the handler of its method. A socket file nothing answers on is
 * replaced; a live one rejects with `upstream_error`, since a second service
 * must not start. The socket is then chmod 0600.
 *
 * A line over `MAX_REQUEST_LINE_LENGTH` gets -32600 and ends the connection;
 * bad JSON gets -32700, a malformed request -32600, an unknown method -32601,
 * and a notification (no id) is ignored. A handler's `ToolError` reaches the
 * client with its code; any other throw reaches it only as `internal_error`.
 */
export async function serveService(
  socketPath: string,
  handlers: Record<string, ServiceHandler>,
  options: ServeOptions = {},
): Promise<ServiceServer> {
  await claimSocketPath(socketPath)
  const connections = new Set<Socket>()
  const server = createServer((socket) => {
    connections.add(socket)
    socket.once("close", () => connections.delete(socket))
    new Connection(socket, handlers, options)
  })
  let listening = false
  try {
    await listen(server, socketPath)
    listening = true
    await chmod(socketPath, SOCKET_FILE_MODE)
  } catch (error) {
    await closeServer(server)
    // Only a socket this server bound is its own to remove; a failed listen leaves the path as it found it.
    if (listening) await rm(socketPath, { force: true })
    const code = (error as NodeJS.ErrnoException).code
    throw new ToolError(
      "internal_error",
      `The sync service could not listen at its socket${code ? ` (${code})` : ""}.`,
      {
        cause: error,
      },
    )
  }
  // An accept error on a running server must not crash the service; the connections it breaks end on their own.
  server.on("error", () => {})

  let closing: Promise<void> | undefined
  const shutDown = async () => {
    // Each connection aborts its calls as it closes, so wait for that rather than for the server's own bookkeeping.
    const closed = [...connections].map((socket) => new Promise((resolve) => socket.once("close", resolve)))
    for (const socket of connections) socket.destroy()
    await Promise.all(closed)
    await closeServer(server)
    await rm(socketPath, { force: true })
  }
  return {
    close() {
      closing ??= shutDown()
      return closing
    },
  }
}
