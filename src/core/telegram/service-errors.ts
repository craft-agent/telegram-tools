import { ToolError, type ErrorCode } from "../errors"

/** What every `uncertain` error tells the person to do. */
export const UNCERTAIN_ADVICE = "Check the chat in Telegram before trying again."

/** `+` and then six or more digits, each optionally preceded by a space or a dash. */
const PHONE_NUMBER = /\+(?:[ -]?\d){6,}/g

/** How much of the service's own message text an error carries. */
const MAX_DETAIL_LENGTH = 300

/** The standard JSON-RPC error codes the client and the service both use. */
export const RpcCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
} as const

/** The JSON-RPC code of the service's own failures; its `data.code` is the `ErrorCode` the client throws. */
export const ServiceErrorCode = -32000

/** Whether a call can change something on Telegram: a write that fails after its request was written may have taken effect. */
export type CallEffect = "read" | "write"

/** Every `ErrorCode`; the type makes the compiler list a code added to `ErrorCode` here too. */
const ERROR_CODES: Record<ErrorCode, true> = {
  not_found: true,
  forbidden: true,
  invalid_argument: true,
  stale: true,
  unauthenticated: true,
  rate_limited: true,
  declined: true,
  upstream_error: true,
  uncertain: true,
  internal_error: true,
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(ERROR_CODES, value)
}

/** The service's own message text: phone-number-like text replaced with `[number]`, trimmed, and cut. */
function cut(message: string): string {
  return message.replace(PHONE_NUMBER, "[number]").trim().slice(0, MAX_DETAIL_LENGTH)
}

/** The service's own message text for an error: masked, cut, and led by `: `; empty when there is none. */
export function detail(message: string): string {
  const text = cut(message)
  return text ? `: ${text}` : ""
}

/** A failure that leaves the outcome unknown once the request was written: `uncertain` for a write, `upstream_error` for a read. */
export function afterWriteError(method: string, effect: CallEffect, reason: string): ToolError {
  return effect === "write"
    ? new ToolError("uncertain", `${method} may have taken effect (${reason}). ${UNCERTAIN_ADVICE}`)
    : new ToolError("upstream_error", `${method} failed (${reason}).`)
}

/**
 * The error a JSON-RPC error reply stands for. The standard codes mean nothing
 * was done, so a write is no more uncertain than a read; a service failure
 * with a known `data.code` is thrown as that code, except that a write's
 * `internal_error` is `uncertain`: the service failed in code that may have
 * reached Telegram, whereas every other code is thrown by a handler that knows
 * nothing left. Anything else leaves the outcome open and is judged like a
 * failure after the write.
 */
export function rpcError(
  method: string,
  effect: CallEffect,
  code: number | undefined,
  message: string,
  data?: unknown,
): ToolError {
  if (code === ServiceErrorCode) {
    const serviceCode = isRecord(data) ? data.code : undefined
    if (serviceCode === "internal_error" && effect === "write") {
      return afterWriteError(method, effect, "the service failed on it")
    }
    if (isErrorCode(serviceCode)) return new ToolError(serviceCode, cut(message) || `${method} failed.`)
  }
  switch (code) {
    case RpcCode.ParseError:
    case RpcCode.InvalidRequest:
      return new ToolError("internal_error", `The service found the ${method} request malformed${detail(message)}`)
    case RpcCode.MethodNotFound:
      return new ToolError(
        "upstream_error",
        `The service does not know ${method}; restart the service, or update it if it is an older version.`,
      )
    case RpcCode.InvalidParams:
      return new ToolError("invalid_argument", `The service refused the arguments of ${method}${detail(message)}`)
    default:
      return afterWriteError(
        method,
        effect,
        `the service answered with error ${code === undefined ? "without a code" : code}${detail(message)}`,
      )
  }
}

/** Whether a parsed JSON value is an object that is not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
