import { tl } from "@mtcute/core"
import { ToolError } from "../errors"
import { SYNC_STATUS, type SyncStatus } from "./mirror-meta"
import { rpcTextOf } from "./rpc-errors"

/** How a run of the sync service ended. */
export type SyncOutcome = {
  /** What a process supervisor needs: 0 when there is nothing to run, the session ended or a stop was requested; 1 after a failure worth a restart. */
  exitCode: 0 | 1
  status: "not logged in" | "logged out" | "stopped" | "failed"
  /** Why, in words without content, ids or names. */
  reason?: string
}

/** What ended a run that had started. */
export type Ended =
  | { kind: "stop" }
  | { kind: "session-ended" }
  | { kind: "storage" }
  | { kind: "connection" }
  | { kind: "error"; reason: string }

/** What the log says when a label has no session. */
export const NOT_LOGGED_IN_MESSAGE = "not logged in; log in first"
/** What the log says when a label has a session but no app credentials. */
export const NO_APP_MESSAGE = "no app credentials; log in first"
/** What the mirror's `error` and the outcome say once Telegram has ended the session. */
export const SESSION_ENDED_REASON = "Telegram ended this session; log in again"
/** Why receiving stopped when the mirror could not be written. */
export const STORAGE_FAILURE_REASON = "the mirror cannot be written; receiving stopped"
/** Why the run failed when the connection stayed down. */
export const CONNECTION_LOST_REASON = "the connection to Telegram could not be kept"
/** Why the run failed when the mirror holds another account's messages. */
export const OTHER_ACCOUNT_REASON = "this mirror belongs to another account"

/** What a run ended with, and what to record and tell about it. */
export type Settled = {
  status: Extract<SyncStatus, "stopped" | "logged out" | "failed">
  /** For the mirror's `error`; null for none. */
  error: string | null
  /** The line for the log. */
  message: string
  outcome: SyncOutcome
}

/** What an error is called in a log line: Telegram's name for it, a `ToolError`'s own message, else the error's class; never its message. */
export function errorLabel(error: unknown): string {
  const text = rpcTextOf(error)
  if (text !== undefined) return text
  if (error instanceof ToolError) return error.message
  return error instanceof Error ? error.name : "unexpected error"
}

/** Why a failure ended the run, as a sentence for the mirror and the outcome. */
export function failureReason(error: unknown): string {
  if (error instanceof ToolError) return error.message
  if (tl.RpcError.is(error)) return `Telegram answered ${errorLabel(error)}`
  return `unexpected error (${errorLabel(error)})`
}

/** Decides the outcome of a run from what ended it. */
export function settle(ended: Ended): Settled {
  switch (ended.kind) {
    case "stop":
      return {
        status: SYNC_STATUS.stopped,
        error: null,
        message: "stopped",
        outcome: { exitCode: 0, status: "stopped" },
      }
    case "session-ended":
      return {
        status: SYNC_STATUS.loggedOut,
        error: SESSION_ENDED_REASON,
        message: "Telegram ended this session; staying down until it is logged in again",
        outcome: { exitCode: 0, status: "logged out", reason: SESSION_ENDED_REASON },
      }
    case "storage":
      return failedWith(STORAGE_FAILURE_REASON)
    case "connection":
      return failedWith(CONNECTION_LOST_REASON)
    case "error":
      return failedWith(ended.reason)
  }
}

function failedWith(reason: string): Settled {
  return {
    status: SYNC_STATUS.failed,
    error: reason,
    message: `sync ended: ${reason}`,
    outcome: { exitCode: 1, status: "failed", reason },
  }
}
