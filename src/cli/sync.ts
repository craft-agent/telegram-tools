import { isToolError } from "../core"
import { pickLabel, type LabelPaths } from "../core/telegram/labels"
import { runSync } from "../core/telegram/sync"
import { NOT_LOGGED_IN_MESSAGE } from "../core/telegram/sync-outcome"
import { handleCommandError, parseCommandServiceSettings, parseFlagArgs } from "./command-args"
import { EXIT_OK, type CommandIo } from "./command-io"
import { logLine, openCommandClient } from "./telegram-client"

const ACCOUNT_FLAG = "--account"

type SyncCommand = {
  paths: LabelPaths
  stateDir: string
  keepDisappearing: boolean
  channels: boolean
}

/** Reads the command line: `--account` and the settings flags the service takes. */
async function parseSync(argv: string[], io: CommandIo): Promise<SyncCommand> {
  const { values, rest } = parseFlagArgs(argv, { values: [ACCOUNT_FLAG] })
  const settings = parseCommandServiceSettings(rest, io)
  return {
    paths: await pickLabel(settings.state_dir, values[ACCOUNT_FLAG]),
    stateDir: settings.state_dir,
    keepDisappearing: settings.keep_disappearing,
    channels: settings.channels,
  }
}

/**
 * The `sync` command: runs the sync service of one account in the foreground
 * (`--account`, or the only logged-in one): it keeps the account's mirror
 * current until it is stopped, and logs to standard error. `--keep-disappearing`
 * and `--channels` are the settings of that name. Resolves to the exit code:
 * 0 on a stop request and when there is nothing to run (no logged-in account,
 * or Telegram ended the session), 1 after any other failure, 2 for a mistake
 * in the command line (several accounts without `--account` included).
 */
export async function runSyncCommand(argv: string[], io: CommandIo): Promise<number> {
  let command: SyncCommand
  try {
    command = await parseSync(argv, io)
  } catch (error) {
    // No such account is "not logged in", which is nothing to run, not a failure to restart.
    if (isToolError(error) && error.code === "not_found") {
      logLine(io)(NOT_LOGGED_IN_MESSAGE)
      return EXIT_OK
    }
    return handleCommandError(error, io, { mode: "auto" })
  }

  try {
    const outcome = await (io.runSync ?? runSync)({
      stateDir: command.stateDir,
      label: command.paths.label,
      keepDisappearing: command.keepDisappearing,
      channels: command.channels,
      openClient: (app) => openCommandClient(io, command.paths.session, app),
      log: logLine(io),
      signal: io.signal,
    })
    return outcome.exitCode
  } catch (error) {
    return handleCommandError(error, io)
  }
}
