import { existsSync, realpathSync } from "node:fs"
import { ToolError } from "../core"
import { checkLabel, labelPaths, pickLabel } from "../core/telegram/labels"
import {
  defaultServiceHost,
  installService,
  serviceStatus,
  serviceWorkingDirectory,
  uninstallService,
  type ServiceHost,
  type ServiceName,
  type ServiceSpec,
} from "../core/telegram/service-host"
import {
  missingServiceFiles,
  readServiceRecord,
  removeServiceRecord,
  writeServiceRecord,
} from "../core/telegram/service-record"
import { lockHolder } from "../core/telegram/sync-lock"
import type { ServiceSettings } from "../entry/settings"
import { PROJECT } from "../project"
import { handleCommandError, parseCommandServiceSettings, parseFlagArgs, usageError } from "./command-args"
import { EXIT_OK, type CommandIo } from "./command-io"
import { pickStableProgram } from "./service-program"

/** The service's identity for the service manager; the label is appended to it. */
export const SERVICE_ID = "io.github.craft-agent.telegram-tools"

/** The name the macOS Login Items list shows for the agent, before `-<label>`. */
export const SERVICE_LAUNCHER = `${PROJECT.name}-sync`

/** What names the service on disk, passed to uninstall. */
export const SERVICE_NAME: ServiceName = { id: SERVICE_ID, launcher: SERVICE_LAUNCHER }

const SERVICE_DESCRIPTION = "Telegram sync service"

type ServiceAction = "install" | "uninstall" | "status"

type ServiceCommandArgs = {
  action: ServiceAction
  label?: string
  settings: ServiceSettings
}

function parseServiceArgs(argv: string[], io: CommandIo): ServiceCommandArgs {
  const args = argv[0] === "service" ? argv.slice(1) : argv
  const action = args[0]
  if (action !== "install" && action !== "uninstall" && action !== "status") {
    const given = action === undefined ? "No service command given" : `Unknown service command "${action}"`
    throw usageError(`${given}; use service install|uninstall|status.`)
  }

  const { values, rest } = parseFlagArgs(args.slice(1), { values: ["--account"] })
  const account = values["--account"]
  return {
    action,
    label: account !== undefined ? checkLabel(account) : undefined,
    settings: parseCommandServiceSettings(rest, io),
  }
}

/** The node binary and the CLI script the unit runs: those given, else this process's. */
function resolveSelf(self?: { program: string; script: string }): { program: string; script: string } {
  const program = self?.program ?? process.execPath
  let script = self?.script
  if (!script) {
    const raw = process.argv[1] ?? ""
    try {
      script = raw ? realpathSync(raw) : ""
    } catch {
      script = raw
    }
  }
  return { program, script }
}

/** The arguments the unit runs the sync command with; the two booleans only when on. */
function syncArgs(script: string, label: string, settings: ServiceSettings): string[] {
  return [
    script,
    "sync",
    "--account",
    label,
    "--state-dir",
    settings.state_dir,
    ...(settings.keep_disappearing ? ["--keep-disappearing"] : []),
    ...(settings.channels ? ["--channels"] : []),
  ]
}

async function install(label: string, settings: ServiceSettings, host: ServiceHost, io: CommandIo): Promise<void> {
  if (!existsSync(labelPaths(settings.state_dir, label).session)) {
    throw new ToolError(
      "invalid_argument",
      `This label is not logged in; log in first with: ${PROJECT.cli} login --account ${label}`,
    )
  }

  const running = lockHolder(labelPaths(settings.state_dir, label).syncLock)
  if (running !== undefined) {
    io.stdout(
      `Warning: ${PROJECT.cli} sync is running in the foreground (pid ${running}); the installed service will keep retrying every minute until it is stopped.\n`,
    )
  }

  const self = resolveSelf(io.self)
  const path = io.env.PATH ?? process.env.PATH ?? ""
  const picked = await pickStableProgram({
    program: self.program,
    version: io.self?.version ?? process.versions.node,
    path,
    home: host.home,
    cwd: serviceWorkingDirectory(host),
    volatileRoots: [io.env.TMPDIR ?? "", io.env.XDG_RUNTIME_DIR ?? ""],
  })
  const spec: ServiceSpec = {
    ...SERVICE_NAME,
    label,
    description: SERVICE_DESCRIPTION,
    program: picked.program,
    args: syncArgs(self.script, label, settings),
    path,
  }

  // Removed first, so an install that fails part way leaves no record of an older program.
  const paths = labelPaths(settings.state_dir, label)
  await removeServiceRecord(paths)
  const result = await installService(spec, host)
  await writeServiceRecord(paths, { program: picked.program, script: self.script })
  io.stdout(`Installed sync service for "${label}" (${result.file}).\n`)
  if (result.log) {
    io.stdout(`${host.platform === "darwin" ? "Logs are written to" : "View logs with"}: ${result.log}\n`)
  }
  io.stdout("The service starts automatically at logon and restarts after a failure.\n")
  io.stdout("Install the service again after updating Node or this package, as it records both paths.\n")
  if (host.platform === "linux") {
    io.stdout('Run "loginctl enable-linger" to keep the service running while logged out.\n')
  }
  if (picked.versioned) {
    io.stderr(
      `Warning: the service runs Node at a path that holds its version (${picked.program}); removing that version stops the service. Install the service again after updating Node, or put a node at a path without the version first on PATH.\n`,
    )
  }
}

async function status(label: string, settings: ServiceSettings, host: ServiceHost, io: CommandIo): Promise<void> {
  const result = await serviceStatus(SERVICE_ID, label, host)
  io.stdout(`Sync service for "${label}":\n`)
  io.stdout(`  Installed: ${result.installed ? "yes" : "no"}\n`)
  io.stdout(`  Running: ${result.running ? "yes" : "no"}\n`)
  if (result.pid !== undefined) io.stdout(`  PID: ${result.pid}\n`)
  if (result.lastExit !== undefined) io.stdout(`  Last exit: ${result.lastExit}\n`)
  io.stdout(`  File: ${result.file}\n`)
  if (result.log) io.stdout(`  Log: ${result.log}\n`)

  const record = readServiceRecord(labelPaths(settings.state_dir, label))
  if (record) {
    io.stdout(`  Program: ${record.program}\n`)
    io.stdout(`  Script: ${record.script}\n`)
    const missing = missingServiceFiles(record)
    for (const name of missing) {
      io.stdout(`  Missing: ${record[name]}\n`)
    }
    if (missing.length > 0) {
      io.stdout(
        `The ${missing.join(" and ")} it was installed with ${missing.length > 1 ? "are" : "is"} gone, as after updating Node or this package; install it again with: ${PROJECT.cli} service install --account ${label}\n`,
      )
    }
  }
}

/**
 * The `service` command: installs, uninstalls or queries the background sync
 * service of one account (`--account`, or the only logged-in one). `install`
 * bakes `--state-dir` and, when on, `--keep-disappearing` and `--channels`
 * into the unit. Resolves to the exit code.
 */
export async function runServiceCommand(argv: string[], io: CommandIo): Promise<number> {
  const host: ServiceHost = io.serviceHost ?? defaultServiceHost()

  let parsed: ServiceCommandArgs
  try {
    parsed = parseServiceArgs(argv, io)
  } catch (error) {
    return handleCommandError(error, io, { mode: "usage" })
  }
  const { action, settings } = parsed

  let label: string
  try {
    label = parsed.label ?? (await pickLabel(settings.state_dir, undefined)).label
  } catch (error) {
    return handleCommandError(error, io, { mode: "auto" })
  }

  try {
    if (action === "install") {
      await install(label, settings, host, io)
    } else if (action === "uninstall") {
      await uninstallService(SERVICE_NAME, label, host)
      await removeServiceRecord(labelPaths(settings.state_dir, label))
      io.stdout(`Uninstalled sync service for "${label}".\n`)
    } else {
      await status(label, settings, host, io)
    }
    return EXIT_OK
  } catch (error) {
    return handleCommandError(error, io, { abortMessage: "Service command was cancelled." })
  }
}
