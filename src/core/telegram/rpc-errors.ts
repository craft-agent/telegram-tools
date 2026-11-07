import { tl } from "@mtcute/core"

/** The errors Telegram answers with when a session no longer works and only a new login helps. */
export const SESSION_ENDED_ERRORS: readonly string[] = [
  "AUTH_KEY_UNREGISTERED",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
  "USER_DEACTIVATED",
  "USER_DEACTIVATED_BAN",
  "AUTH_KEY_DUPLICATED",
]

/** The name Telegram gave an error (such as `FLOOD_WAIT_30`), or undefined when it is not one of Telegram's. */
export function rpcTextOf(error: unknown): string | undefined {
  return tl.RpcError.is(error) ? String(error.text) : undefined
}

/** Whether Telegram ended the session with this error. */
export function isSessionEnded(error: unknown): boolean {
  const text = rpcTextOf(error)
  return text !== undefined && SESSION_ENDED_ERRORS.includes(text)
}

/** How many seconds a flood wait asks for, or undefined when the error is not one. */
export function floodWaitSecondsOf(error: unknown): number | undefined {
  if (!tl.RpcError.is(error)) return undefined
  const { seconds } = error as { seconds?: unknown }
  if (typeof seconds === "number") return seconds
  const match = /^FLOOD_WAIT_(\d+)$/.exec(String(error.text))
  return match ? Number(match[1]) : undefined
}
