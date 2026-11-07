import { Socket } from "node:net"
import { ToolError } from "../errors"
import { abortError } from "../exec"
import { afterWriteError, isRecord, rpcError, type CallEffect } from "./service-errors"
import { LineReader, MAX_REQUEST_LINE_LENGTH } from "./service-lines"

export type { CallEffect }

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000
const DEFAULT_CALL_TIMEOUT_MS = 30_000
const DEFAULT_MAX_LINE_LENGTH = 64 * 1024 * 1024
const NOT_RUNNING_MESSAGE = "The sync service is not running at this account's socket. Start it and try again."

export type CallOptions = {
  /** Whether the call can change something on Telegram; a write that fails after its request was written is `uncertain`. */
  effect: CallEffect
  /** How long the call may take from the moment it starts; 30 seconds by default. */
  timeoutMs?: number
  /** Cancels the call. A read rejects with an `AbortError`; a write already written rejects as `uncertain`. */
  signal?: AbortSignal
}

export type ConnectOptions = {
  /** How long connecting may take; 5 seconds by default. */
  timeoutMs?: number
  signal?: AbortSignal
  /**
   * The longest line the service may send before the connection is dropped,
   * counted in characters of the decoded text; 64 * 1024 * 1024 characters by default.
   */
  maxLineLength?: number
}

/** What the service, or the loss of the connection, made of one request. */
type Reply = { result: unknown } | { error: { code: number; message: string; data: unknown } } | { lost: string }

/**
 * The reply a message with a pending call's id stands for. Only a JSON-RPC 2.0
 * envelope with exactly one of `result` and `error` (an object with a numeric
 * `code` and a string `message`) is a definite answer; anything else is a
 * protocol loss, judged like any failure after the write.
 */
function replyOf(message: Record<string, unknown>): Reply {
  const malformed = { lost: "the service answered it malformed" }
  if (message.jsonrpc !== "2.0" || "result" in message === "error" in message) return malformed
  if ("result" in message) return { result: message.result }
  const { error } = message
  if (!isRecord(error) || typeof error.code !== "number" || typeof error.message !== "string") return malformed
  return { error: { code: error.code, message: error.message, data: error.data } }
}

/** The result of a reply, or the error it stands for. */
function resultOf(method: string, effect: CallEffect, reply: Reply): unknown {
  if ("result" in reply) return reply.result
  if ("lost" in reply) throw afterWriteError(method, effect, reply.lost)
  throw rpcError(method, effect, reply.error.code, reply.error.message, reply.error.data)
}

/**
 * A connection to the sync service's socket: newline-delimited JSON-RPC 2.0.
 * Several calls may be in flight at once; each is answered by its id.
 */
export class ServiceConnection {
  /** Settles once the connection is gone, whoever ended it; it never rejects. */
  readonly closed: Promise<void>

  private readonly socket: Socket
  private readonly lines: LineReader
  private readonly pending = new Map<number, (reply: Reply) => void>()
  private nextId = 1
  /** Why the connection is gone or going; set by whoever ends it first. */
  private endReason: string | undefined

  private constructor(socket: Socket, maxLineLength: number) {
    this.socket = socket
    this.lines = new LineReader(maxLineLength)
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => this.onData(chunk))
    socket.on("error", (error: NodeJS.ErrnoException) => {
      this.endReason ??= `the connection to the service broke${error.code ? ` (${error.code})` : ""}`
    })
    this.closed = new Promise((resolve) => {
      socket.once("close", () => {
        this.endReason ??= "the service closed the connection"
        const lost: Reply = { lost: this.endReason }
        for (const settle of [...this.pending.values()]) settle(lost)
        resolve()
      })
    })
  }

  /** Connects to the service's socket; rejects as `upstream_error` when nothing is listening there. */
  static connect(socketPath: string, options: ConnectOptions = {}): Promise<ServiceConnection> {
    const { timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS, signal, maxLineLength = DEFAULT_MAX_LINE_LENGTH } = options
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal))
        return
      }
      const socket = new Socket()
      let timer: ReturnType<typeof setTimeout> | undefined

      const detach = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        socket.off("connect", onConnect)
        socket.off("error", onFailure)
      }
      const stop = (error: Error) => {
        detach()
        socket.on("error", () => {})
        socket.destroy()
        reject(error)
      }
      const onConnect = () => {
        detach()
        resolve(new ServiceConnection(socket, maxLineLength))
      }
      // The OS error and the path are left out on purpose: the path holds the state directory.
      const onFailure = () => stop(new ToolError("upstream_error", NOT_RUNNING_MESSAGE))
      const onAbort = () => stop(abortError(signal!))

      socket.once("connect", onConnect)
      socket.once("error", onFailure)
      signal?.addEventListener("abort", onAbort, { once: true })
      timer = setTimeout(onFailure, timeoutMs)
      try {
        socket.connect({ path: socketPath })
      } catch {
        onFailure()
      }
    })
  }

  /**
   * Calls a method and returns its result. Failures map to the error codes of
   * docs/conventions.md; once the request was handed to the socket, a write
   * that fails without a definite answer rejects as `uncertain`, a failed
   * socket write included.
   */
  call<T = unknown>(method: string, params: Record<string, unknown> | undefined, options: CallOptions): Promise<T> {
    const { effect, timeoutMs = DEFAULT_CALL_TIMEOUT_MS, signal } = options
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal))
        return
      }
      if (this.endReason !== undefined) {
        reject(new ToolError("upstream_error", `${method} was not sent (${this.endReason}).`))
        return
      }

      const id = this.nextId++
      // Serialized first: a request that cannot be written registers nothing and sends nothing.
      let request: string
      try {
        request = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })
      } catch {
        reject(new ToolError("invalid_argument", `${method} was not sent: its arguments cannot be written as JSON.`))
        return
      }
      // The service would refuse the line and end the connection, so nothing is written.
      if (request.length > MAX_REQUEST_LINE_LENGTH) {
        reject(new ToolError("invalid_argument", `The ${method} request is too large for the service.`))
        return
      }
      const line = `${request}\n`

      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (produce: () => unknown) => {
        if (!this.pending.delete(id)) return
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        try {
          resolve(produce() as T)
        } catch (error) {
          reject(error)
        }
      }
      const onAbort = () =>
        finish(() => {
          throw effect === "read" ? abortError(signal!) : afterWriteError(method, effect, "the call was cancelled")
        })

      this.pending.set(id, (reply) => finish(() => resultOf(method, effect, reply)))
      signal?.addEventListener("abort", onAbort, { once: true })
      timer = setTimeout(
        () =>
          finish(() => {
            throw afterWriteError(method, effect, `the service did not answer within ${timeoutMs} ms`)
          }),
        timeoutMs,
      )

      // Not even a failed write proves that no byte left, so it is judged like any failure after the write.
      const onWriteFailure = () =>
        finish(() => {
          throw afterWriteError(method, effect, "could not write to the service")
        })
      try {
        this.socket.write(line, (error) => {
          if (error) onWriteFailure()
        })
      } catch {
        onWriteFailure()
      }
    })
  }

  /** Closes the connection; calls still in flight settle by the rules of `call`. */
  close(): void {
    this.end("the connection was closed")
  }

  private end(reason: string): void {
    this.endReason ??= reason
    this.socket.destroy()
  }

  private onData(chunk: string): void {
    const { lines, overflow } = this.lines.push(chunk)
    for (const line of lines) {
      this.onLine(line)
      if (this.socket.destroyed) return
    }
    if (overflow) this.end("the service sent a line that is too long")
  }

  /** Settles the call a reply answers; a reply to an id nobody waits for is ignored. */
  private onLine(line: string): void {
    if (!line.trim()) return
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      message = undefined
    }
    if (!isRecord(message)) {
      this.end("the service sent a line that is not JSON-RPC")
      return
    }
    if (typeof message.id !== "number") return
    this.pending.get(message.id)?.(replyOf(message))
  }
}

/** One call on its own short connection, closed when the call settles. */
export async function callService<T = unknown>(
  socketPath: string,
  method: string,
  params: Record<string, unknown> | undefined,
  options: CallOptions,
): Promise<T> {
  const connection = await ServiceConnection.connect(socketPath, { signal: options.signal })
  try {
    return await connection.call<T>(method, params, options)
  } finally {
    connection.close()
  }
}
