import { existsSync } from "node:fs"
import { isToolError } from "../core"
import { checkLabel, labelPaths } from "../core/telegram/labels"
import { removeLabel } from "../core/telegram/removal"
import { defaultServiceHost, removeServiceLog, uninstallService } from "../core/telegram/service-host"
import { handleCommandError, parseCommandStateDir, parseFlagArgs, printCommandError, usageError } from "./command-args"
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CommandIo } from "./command-io"
import { END_SESSION_HINT } from "./logout"
import { askLine, isTerminal } from "./prompts"
import { SERVICE_ID } from "./service"

type RemoveArgs = {
  label: string
  yes: boolean
  stateDir: string
}

function parseRemoveArgs(argv: string[], io: CommandIo): RemoveArgs {
  const args = argv[0] === "remove" ? argv.slice(1) : argv
  const { values, switches, rest } = parseFlagArgs(args, {
    values: ["--account"],
    switches: ["--yes"],
  })
  const stateDir = parseCommandStateDir(rest, io)

  const account = values["--account"]
  if (account === undefined) {
    throw usageError("Option --account is required.")
  }

  return {
    label: checkLabel(account),
    yes: switches.has("--yes"),
    stateDir,
  }
}

/**
 * The `remove` command: permanently deletes an account's state directory
 * (session, app credentials and received message history) after uninstalling
 * its service. Needs `--yes`, or the label typed on a terminal. Resolves to
 * the exit code.
 */
export async function runRemoveCommand(argv: string[], io: CommandIo): Promise<number> {
  let parsed: RemoveArgs
  try {
    parsed = parseRemoveArgs(argv, io)
  } catch (error) {
    return handleCommandError(error, io, { mode: "usage" })
  }

  const { label, yes, stateDir } = parsed

  if (!yes) {
    if (!isTerminal(io)) {
      printCommandError(io, "Removing an account without a terminal requires --yes.")
      return EXIT_USAGE
    }

    io.stdout(
      `This will permanently delete the session, app credentials, and received message history for "${label}".\n`,
    )
    const answer = await askLine(io, `To confirm, please type the label name "${label}": `)
    if (answer.trim() !== label) {
      printCommandError(io, "Removal cancelled.")
      return EXIT_FAILED
    }
  }

  try {
    const host = io.serviceHost ?? defaultServiceHost()
    const wasLoggedIn = existsSync(labelPaths(stateDir, label).session)
    await removeLabel({
      stateDir,
      label,
      uninstall: async () => {
        try {
          await uninstallService(SERVICE_ID, label, host)
        } catch (error) {
          // On unsupported platforms, services cannot be installed so removal may proceed.
          if (isToolError(error) && error.code === "invalid_argument") {
            return
          }
          throw error
        }
      },
    })
    await removeServiceLog(SERVICE_ID, label, host)

    io.stdout(`Removed "${label}".\n`)
    if (wasLoggedIn) io.stdout(`The session was not ended at Telegram; ${END_SESSION_HINT}.\n`)
    return EXIT_OK
  } catch (error) {
    return handleCommandError(error, io, { abortMessage: "Removal was cancelled." })
  }
}
