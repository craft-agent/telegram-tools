import { readApp } from "../core/telegram/app"
import { pickLabel } from "../core/telegram/labels"
import { logoutLabel } from "../core/telegram/logout"
import { handleCommandError, parseCommandStateDir, parseFlagArgs } from "./command-args"
import { EXIT_OK, type CommandIo } from "./command-io"
import { openCommandClient } from "./telegram-client"

const ACCOUNT_FLAG = "--account"

/** What the person does when Telegram did not end the session itself. */
export const END_SESSION_HINT = "end the session in Telegram under Settings → Devices"

/**
 * The `logout` command: ends the session of one account at Telegram
 * (`--account`, or the only logged-in one) and removes it here; the mirror and
 * the app's credentials are kept. When Telegram cannot be reached the session
 * is removed anyway and the person is told to end it under Settings → Devices.
 * Resolves to the exit code.
 */
export async function runLogoutCommand(argv: string[], io: CommandIo): Promise<number> {
  try {
    const { values, rest } = parseFlagArgs(argv, { values: [ACCOUNT_FLAG] })
    const stateDir = parseCommandStateDir(rest, io)
    const paths = await pickLabel(stateDir, values[ACCOUNT_FLAG])
    const { endedAtTelegram } = await logoutLabel({
      paths,
      openClient: async () => openCommandClient(io, paths.session, readApp(paths.app)),
    })
    io.stdout(
      endedAtTelegram
        ? `Logged out "${paths.label}": Telegram ended the session.\n`
        : `Logged out "${paths.label}" here, but Telegram did not end the session; ${END_SESSION_HINT}.\n`,
    )
    io.stdout("The received message history is kept.\n")
    return EXIT_OK
  } catch (error) {
    return handleCommandError(error, io, { mode: "auto", abortMessage: "Logout was cancelled." })
  }
}
