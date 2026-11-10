import { tl } from "@mtcute/core"
import { ToolError, type ErrorCode } from "../errors"
import { isSessionEnded, rpcTextOf } from "./rpc-errors"
import {
  CALL_TIMEOUT,
  FORBIDDEN_ERRORS,
  NOT_FOUND_ERRORS,
  REFUSAL_CODES,
  rateLimitSecondsOf,
  type SendTrouble,
} from "./sync-send-outcome"

/** How an action speaks of itself in what it answers. */
export type ActionWords = {
  /** The action as a word of its own: `edit`. */
  name: string
  /** What is being done, to finish "before ... it again": `editing`. */
  gerund: string
  /** What the message is once it happened: `edited`. */
  past: string
  /** What is true of the message when Telegram refused: `the message is unchanged`. */
  untouched: string
}

/** Refusals that share an error code and a sentence, by Telegram's names for them. */
export type NamedRefusals = { names: readonly string[]; code: ErrorCode; what: string }

/** What decides the outcome of one action's failed call. */
export type ActionRefusals = {
  words: ActionWords
  /** Telegram's names for "the message is already as asked": the action is done, though this call did nothing. */
  already: readonly string[]
  /** The refusals particular to the action, tried before the groups every action shares. */
  named: readonly NamedRefusals[]
}

/** The refusals that say the message is not there for this account. */
export const MESSAGE_GONE: NamedRefusals = {
  names: ["MESSAGE_ID_INVALID", "MSG_ID_INVALID"],
  code: "not_found",
  what: "Telegram has no such message",
}

/** The error of an action that may have taken effect: `reason` says why in words without content, ids or names. */
export function uncertainAction({ name, gerund }: ActionWords, reason: string): ToolError {
  return new ToolError(
    "uncertain",
    `The ${name} may have gone through (${reason}). Check the message in the chat before ${gerund} it again.`,
  )
}

/** The error of an action Telegram refused before changing anything, with Telegram's name for the refusal. */
function refusedAction({ untouched }: ActionWords, code: ErrorCode, what: string, name: string): ToolError {
  return new ToolError(code, `${what} (${name}); ${untouched}.`)
}

/** The error for a refusal that Telegram gave, when it can be told from its name; undefined for any other. */
function actionRefusalOf(error: tl.RpcError, { words, named }: ActionRefusals): ToolError | undefined {
  const name = String(error.text)
  const seconds = rateLimitSecondsOf(error)
  if (seconds !== undefined) {
    return new ToolError(
      "rate_limited",
      `Telegram is limiting this account; the ${words.name} did not happen. Try again in ${seconds} seconds.`,
    )
  }
  const particular = named.find((refusals) => refusals.names.includes(name))
  if (particular) return refusedAction(words, particular.code, particular.what, name)
  if (FORBIDDEN_ERRORS.includes(name)) {
    return refusedAction(words, "forbidden", `Telegram does not let this account ${words.name} here`, name)
  }
  if (NOT_FOUND_ERRORS.includes(name)) {
    return refusedAction(words, "not_found", "Telegram has no such chat or message", name)
  }
  if (REFUSAL_CODES.includes(error.code) && name !== CALL_TIMEOUT) {
    return refusedAction(words, "upstream_error", `Telegram refused the ${words.name}`, name)
  }
  return undefined
}

/**
 * The error a failed action answers with, or undefined when the failure says
 * the action is done. A name in `already` is done whether or not the
 * connection came back: the end state is the one asked for. A refusal Telegram
 * gave stands as what it says (nothing changed), unless the connection was
 * re-established while the call was out: an earlier delivery may have landed
 * and the refusal may answer the repeat. Everything else leaves the outcome
 * open and is `uncertain`: a server error, mtcute's own timeout, a session
 * that ended, a connection that failed, a call that was abandoned.
 */
export function actionFailureOf(
  error: unknown,
  { reconnected, aborted }: SendTrouble,
  refusals: ActionRefusals,
): ToolError | undefined {
  const { words, already } = refusals
  const name = rpcTextOf(error)
  if (name !== undefined && already.includes(name)) return undefined
  if (isSessionEnded(error)) return uncertainAction(words, "Telegram ended the session")
  if (!tl.RpcError.is(error)) {
    return uncertainAction(words, aborted ? "the request was cancelled" : "the connection to Telegram failed")
  }
  if (reconnected) return uncertainAction(words, `the connection came back while Telegram was answering ${name}`)
  return actionRefusalOf(error, refusals) ?? uncertainAction(words, `Telegram answered ${name}`)
}
