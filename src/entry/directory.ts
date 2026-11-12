import { homedir } from "node:os"
import { isAbsolute, join, resolve, sep } from "node:path"
import { ToolError, type ToolOptions } from "../core"
import type { EntryProfile } from "./profile"

/** The folder of a person's downloads under their home directory. */
const DOWNLOADS_DIR = "Downloads"
const DEFAULT_DOWNLOAD_MAX_MB = 100

/** A directory setting given as text, and where it came from, for error messages. */
export type GivenDirectory = { text: string; source: string }

/** The package's own settings the tools read, resolved: absolute paths and the largest download. */
export type DirectorySettings = {
  /** Where every account's state lives. */
  state_dir: string
  /** Where received files are saved. */
  download_dir: string
  /** The largest received file a call may download, in megabytes. */
  download_max_mb: number
  /** The directories files may be sent from, besides the working directory: absolute paths. */
  send_dirs: string[]
}

/** The user's home directory from `$HOME` (when absolute) or `os.homedir()`. */
export function homeDir(env: Record<string, string | undefined>): string {
  const envHome = env.HOME
  if (envHome && isAbsolute(envHome)) return envHome
  return homedir()
}

/** Resolves a directory setting after expanding a leading `~`; anything else is `invalid_argument` naming the source. */
export function resolveGivenDirectory(given: GivenDirectory, home: string): string {
  const text = given.text.trim()
  const expanded =
    text === "~" ? home : text.startsWith("~/") || text.startsWith(`~${sep}`) ? join(home, text.slice(2)) : text
  if (!text || !isAbsolute(expanded)) {
    throw new ToolError("invalid_argument", `${given.source} must be an absolute path.`)
  }
  return resolve(expanded)
}

/** The state directory when none is given: `$XDG_STATE_HOME/<name>` (when absolute), else `<home>/.local/state/<name>`. */
function defaultStateDir(name: string, env: Record<string, string | undefined>, home: string): string {
  const xdg = env.XDG_STATE_HOME
  return xdg && isAbsolute(xdg) ? resolve(xdg, name) : resolve(home, ".local", "state", name)
}

function text(value: ToolOptions[string] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

/**
 * Fills the defaults of the package's own settings the tools read, from the
 * values `options` holds (already parsed: paths absolute, the download limit
 * checked): the state directory is `$XDG_STATE_HOME/<profile.name>` (when
 * absolute) or `<home>/.local/state/<profile.name>`, the download directory
 * `<home>/Downloads/<profile.name>`, the download limit 100 megabytes and the
 * send directories none.
 */
export function resolveDirectorySettings(
  options: ToolOptions,
  env: Record<string, string | undefined>,
  profile: EntryProfile,
): DirectorySettings {
  const home = homeDir(env)
  const maxMb = options.download_max_mb
  const sendDirs = options.send_dirs
  return {
    state_dir: text(options.state_dir) ?? defaultStateDir(profile.name, env, home),
    download_dir: text(options.download_dir) ?? resolve(home, DOWNLOADS_DIR, profile.name),
    download_max_mb: typeof maxMb === "number" ? maxMb : DEFAULT_DOWNLOAD_MAX_MB,
    send_dirs: Array.isArray(sendDirs) ? [...sendDirs] : [],
  }
}
