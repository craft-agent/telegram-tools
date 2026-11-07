import { release, type } from "node:os"
import type { AppCredentials } from "../core/telegram/app"
import { createTelegramClient, type DeviceInfo, type TelegramClientSettings } from "../core/telegram/client"
import { PROJECT } from "../project"
import type { ClientFactory, CommandClient, CommandIo } from "./command-io"

/** The version a source run reports, since only a bundle has the package version substituted in. */
const DEV_VERSION = "0.0.0-dev"

/** How Telegram lists this client among the account's devices. */
export function deviceInfo(): DeviceInfo {
  return {
    model: `${PROJECT.name} (unofficial)`,
    appVersion: typeof __VERSION__ === "string" ? __VERSION__ : DEV_VERSION,
    systemVersion: `${type()} ${release()}`,
  }
}

/** `<time> <line>` on one line of standard error, for a service's log. */
export function logLine(io: CommandIo): (line: string) => void {
  return (line) => io.stderr(`${new Date().toISOString()} ${line}\n`)
}

/** Builds the client of a label's session with the app's credentials, as this command line identifies itself. */
export function openCommandClient(io: CommandIo, storagePath: string, app: AppCredentials): CommandClient {
  const settings: TelegramClientSettings = {
    storagePath,
    apiId: app.apiId,
    apiHash: app.apiHash,
    device: deviceInfo(),
    log: logLine(io),
  }
  const create: ClientFactory = io.createClient ?? createTelegramClient
  return create(settings)
}
