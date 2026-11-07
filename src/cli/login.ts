import { renderANSI } from "uqr"
import { ToolError, isToolError } from "../core"
import { parseApiHash, parseApiId, readApp, writeApp, type AppCredentials } from "../core/telegram/app"
import { DEFAULT_LABEL, checkLabel, ensureLabelDir, labelPaths, type LabelPaths } from "../core/telegram/labels"
import {
  ALREADY_LOGGED_IN,
  importTelethon,
  isLoggedIn,
  loginByPhone,
  loginByQr,
  type LoggedIn,
  type LoginIo,
} from "../core/telegram/login"
import { removeSessionFiles } from "../core/telegram/logout"
import { acquireSyncLock, lockHolder } from "../core/telegram/sync-lock"
import { PROJECT_PROFILE } from "../entry/profile"
import { PROJECT } from "../project"
import { handleCommandError, parseCommandStateDir, parseFlagArgs, usageError } from "./command-args"
import { EXIT_OK, type CommandIo } from "./command-io"
import { askHidden, askLine, isTerminal } from "./prompts"
import { openCommandClient } from "./telegram-client"

const SYNC_RUNNING = "The sync service for this label is running; stop it first (service uninstall, or stop sync)."
const SCAN_INSTRUCTION = "On your phone, open Telegram > Settings > Devices > Link Desktop Device, and scan this code:"
const APP_INSTRUCTION =
  "Create an app at https://my.telegram.org (API development tools) to get an api_id and api_hash."
const TELETHON_PROMPT = "Telethon string session: "

/** Light modules around the code, which a scanner needs; uqr's ANSI renderer paints them white on any theme. */
const QR_BORDER = 2

type LoginMode = "qr" | "phone" | "telethon"

type LoginCommand = { label: string; stateDir: string; mode: LoginMode }

/** Reads the command line: `--account`, one of `--phone` / `--telethon`, and the state directory. */
function parseLogin(argv: string[], io: CommandIo): LoginCommand {
  const { values, switches, rest } = parseFlagArgs(argv, {
    values: ["--account"],
    switches: ["--phone", "--telethon"],
  })
  if (switches.has("--phone") && switches.has("--telethon")) {
    throw usageError("Options --phone and --telethon cannot be used together.")
  }
  return {
    label: checkLabel(values["--account"] ?? DEFAULT_LABEL),
    stateDir: parseCommandStateDir(rest, io),
    mode: switches.has("--phone") ? "phone" : switches.has("--telethon") ? "telethon" : "qr",
  }
}

/**
 * The app's credentials: both `<envPrefix>_API_ID` and `<envPrefix>_API_HASH` when set, else the label's
 * `app.json`, else asked (the hash without echo). Credentials from the environment or the terminal are saved.
 */
async function appCredentials(paths: LabelPaths, io: CommandIo): Promise<AppCredentials> {
  const prefix = (io.profile ?? PROJECT_PROFILE).envPrefix
  const fromEnv = { id: io.env[`${prefix}_API_ID`]?.trim(), hash: io.env[`${prefix}_API_HASH`]?.trim() }
  let app: AppCredentials
  if (fromEnv.id && fromEnv.hash) {
    app = { apiId: parseApiId(fromEnv.id), apiHash: parseApiHash(fromEnv.hash) }
  } else {
    try {
      return readApp(paths.app)
    } catch (error) {
      if (!isToolError(error)) throw error
    }
    io.stdout(`${APP_INSTRUCTION}\n`)
    const apiId = parseApiId(await askLine(io, "api_id: "))
    app = { apiId, apiHash: parseApiHash(await askHidden(io, "api_hash: ")) }
  }
  writeApp(paths.app, app)
  return app
}

/** The telethon string session: read without echo on a terminal, else from standard input. */
async function telethonSession(io: CommandIo): Promise<string> {
  const text = isTerminal(io) ? await askHidden(io, TELETHON_PROMPT) : ((await io.readStdin?.()) ?? "")
  if (text.trim() === "") throw usageError("No Telethon string session was given.")
  return text
}

function loginIo(io: CommandIo): LoginIo {
  return {
    ask: (prompt) => askLine(io, prompt),
    askHidden: (prompt) => askHidden(io, prompt),
    say: (line) => io.stdout(`${line}\n`),
    showQr(url) {
      io.stdout(`${SCAN_INSTRUCTION}\n\n${renderANSI(url, { border: QR_BORDER })}\n`)
    },
    signal: io.signal ?? new AbortController().signal,
  }
}

/** Logs in on the label's session; a session that was not logged in before and does not end logged in is removed. */
async function logIn(command: LoginCommand, paths: LabelPaths, app: AppCredentials, io: CommandIo): Promise<LoggedIn> {
  const release = acquireSyncLock(paths.syncLock)
  if (release === undefined) throw new ToolError("invalid_argument", SYNC_RUNNING)
  try {
    const client = openCommandClient(io, paths.session, app)
    let loggedBefore: boolean | undefined
    let account: LoggedIn
    try {
      loggedBefore = await isLoggedIn(client)
      if (loggedBefore) throw new ToolError("invalid_argument", ALREADY_LOGGED_IN)
      if (command.mode === "phone") account = await loginByPhone(client, loginIo(io))
      else if (command.mode === "telethon") account = await importTelethon(client, await telethonSession(io))
      else account = await loginByQr(client, loginIo(io))
    } catch (error) {
      await client.destroy().catch(() => {})
      if (loggedBefore === false) await removeSessionFiles(paths.session)
      throw error
    }
    await client.destroy().catch(() => {})
    return account
  } finally {
    release()
  }
}

/**
 * The `login` command: logs a label in (`--account`, `default` without it) by QR code, or with `--phone`
 * (phone number and code) or `--telethon` (a Telethon string session, read without echo or from standard
 * input). The app's credentials come from `<envPrefix>_API_ID` / `_API_HASH`, the label's saved ones, or
 * a question. Resolves to the exit code.
 */
export async function runLogin(argv: string[], io: CommandIo): Promise<number> {
  let command: LoginCommand
  try {
    command = parseLogin(argv, io)
  } catch (error) {
    return handleCommandError(error, io, { mode: "usage" })
  }

  try {
    // Refuses before any prompt; `logIn` takes the lock itself, which is what keeps the service out.
    if (lockHolder(labelPaths(command.stateDir, command.label).syncLock) !== undefined) {
      throw new ToolError("invalid_argument", SYNC_RUNNING)
    }
    const paths = await ensureLabelDir(command.stateDir, command.label)
    const app = await appCredentials(paths, io)
    const account = await logIn(command, paths, app, io)
    io.stdout(`Logged in as ${account.name}.\n`)
    io.stdout(`Start receiving with: ${PROJECT.cli} service install --account ${paths.label}\n`)
    io.stdout(`Or run it in the foreground with: ${PROJECT.cli} sync --account ${paths.label}\n`)
    return EXIT_OK
  } catch (error) {
    return handleCommandError(error, io, { abortMessage: "Login was cancelled." })
  }
}
