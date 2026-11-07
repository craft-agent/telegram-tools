import { SentCode, tl, type User } from "@mtcute/core"
import type { TelegramClient } from "@mtcute/core/client.js"
import { convertFromTelethonSession } from "@mtcute/convert"
import { ToolError, isAbortError } from "../errors"
import { floodWaitSecondsOf, isSessionEnded, rpcTextOf } from "./rpc-errors"

/** The part of mtcute's client the login flows use, so a fake can stand in for it. */
export type LoginClient = Pick<
  TelegramClient,
  "getMe" | "sendCode" | "signIn" | "checkPassword" | "signInQr" | "importSession"
>

/** What a login flow asks of the person and shows them; the entry point supplies it. */
export type LoginIo = {
  /** Asks a question and returns the answer, which stays visible on the terminal. */
  ask(prompt: string): Promise<string>
  /** Asks a question whose answer must not be echoed. */
  askHidden(prompt: string): Promise<string>
  /** Tells the person one line. */
  say(line: string): void
  /** Shows the login URL as a QR code; the URL refreshes, and each one is shown. */
  showQr(url: string): void
  /** Ends the flow when it aborts. */
  signal: AbortSignal
}

/** The account a login ended in: its marked id as a string and its display name, nothing else. */
export type LoggedIn = { id: string; name: string }

/** What the caller tells the person when the label is already logged in. */
export const ALREADY_LOGGED_IN = "This account is already logged in; log out first."

/** How many times a wrong code or a wrong password is asked for, the first time included. */
const MAX_ATTEMPTS = 3

const PHONE_PROMPT = "Phone number (international format): "
const CODE_PROMPT = "Login code: "
const PASSWORD_PROMPT = "Two-step verification password: "

/** Plain reasons for the errors a wrong phone number brings. */
const PHONE_REASONS: Readonly<Record<string, string>> = {
  PHONE_NUMBER_INVALID: "Telegram does not accept this phone number; check it and log in again.",
  PHONE_NUMBER_BANNED: "Telegram has banned this phone number from logging in.",
  PHONE_NUMBER_UNOCCUPIED: "No Telegram account uses this phone number.",
}

/**
 * Maps what a login call threw to the error to rethrow: a `ToolError` or an abort passes as it is, a flood
 * wait is `rate_limited`, a wrong phone number is `invalid_argument`, and any other Telegram error is
 * `upstream_error` carrying only its text name, never its message.
 */
function loginError(error: unknown): unknown {
  if (error instanceof ToolError || isAbortError(error)) return error
  if (!tl.RpcError.is(error)) return error
  const text = String(error.text)
  const seconds = floodWaitSecondsOf(error)
  if (seconds !== undefined || error.code === tl.RpcError.FLOOD) {
    const wait = seconds === undefined ? "a while" : `${seconds} seconds`
    return new ToolError("rate_limited", `Telegram asks to wait ${wait} before logging in again.`)
  }
  if (text === "PHONE_CODE_EXPIRED") {
    return new ToolError("invalid_argument", "The code expired; log in again.")
  }
  const reason = PHONE_REASONS[text]
  if (reason) return new ToolError("invalid_argument", reason)
  return new ToolError("upstream_error", `Telegram refused the login (${text}).`)
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw loginError(error)
  }
}

function loggedInOf(user: User): LoggedIn {
  return { id: String(user.id), name: user.displayName }
}

/** Whether the label's session is logged in; any other failure is rethrown as a `ToolError`. */
export async function isLoggedIn(client: LoginClient): Promise<boolean> {
  try {
    await client.getMe()
    return true
  } catch (error) {
    const text = rpcTextOf(error)
    if (text === "AUTH_KEY_UNREGISTERED" || text === "SESSION_PASSWORD_NEEDED") return false
    throw loginError(error)
  }
}

function tooManyPasswords(): ToolError {
  return new ToolError("invalid_argument", "The two-step verification password was wrong too many times; log in again.")
}

/** Logs in by QR code, showing each refreshed URL, and asks the two-step password when needed. */
export async function loginByQr(client: LoginClient, io: LoginIo): Promise<LoggedIn> {
  let wrongPasswords = 0
  return guarded(async () => {
    const user = await client.signInQr({
      onUrlUpdated: (url) => io.showQr(url),
      password: () => io.askHidden(PASSWORD_PROMPT),
      invalidPasswordCallback: () => {
        wrongPasswords += 1
        if (wrongPasswords >= MAX_ATTEMPTS) throw tooManyPasswords()
      },
      abortSignal: io.signal,
    })
    return loggedInOf(user)
  })
}

async function checkTwoStepPassword(client: LoginClient, io: LoginIo): Promise<User> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const password = await io.askHidden(PASSWORD_PROMPT)
    try {
      return await client.checkPassword({ password, abortSignal: io.signal })
    } catch (error) {
      if (rpcTextOf(error) !== "PASSWORD_HASH_INVALID") throw error
      io.say("That password is wrong.")
    }
  }
  throw tooManyPasswords()
}

async function signInWithCode(client: LoginClient, io: LoginIo, phone: string, phoneCodeHash: string): Promise<User> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const phoneCode = (await io.ask(CODE_PROMPT)).trim()
    try {
      return await client.signIn({ phone, phoneCodeHash, phoneCode, abortSignal: io.signal })
    } catch (error) {
      const text = rpcTextOf(error)
      if (text === "SESSION_PASSWORD_NEEDED") return checkTwoStepPassword(client, io)
      if (text !== "PHONE_CODE_INVALID") throw error
      io.say("That code is not right.")
    }
  }
  throw new ToolError("invalid_argument", "The code was wrong too many times; log in again.")
}

/** Logs in by phone number and code, then by the two-step password when needed; the number is kept nowhere. */
export async function loginByPhone(client: LoginClient, io: LoginIo): Promise<LoggedIn> {
  return guarded(async () => {
    const phone = (await io.ask(PHONE_PROMPT)).trim()
    const sent = await client.sendCode({ phone, abortSignal: io.signal })
    if (!(sent instanceof SentCode)) return loggedInOf(sent)
    return loggedInOf(await signInWithCode(client, io, phone, sent.phoneCodeHash))
  })
}

/** Imports a Telethon v1 string session and checks that Telegram accepts it. */
export async function importTelethon(client: LoginClient, sessionText: string): Promise<LoggedIn> {
  let data: ReturnType<typeof convertFromTelethonSession>
  try {
    data = convertFromTelethonSession(sessionText.trim())
  } catch {
    throw new ToolError("invalid_argument", "This is not a Telethon string session.")
  }
  try {
    await client.importSession(data, true)
    return loggedInOf(await client.getMe())
  } catch (error) {
    if (isSessionEnded(error)) {
      throw new ToolError("unauthenticated", "Telegram does not accept this session.")
    }
    throw loginError(error)
  }
}
