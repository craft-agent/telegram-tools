import { homedir } from "node:os"
import { isAbsolute, join, resolve, sep } from "node:path"
import { ToolError } from "../core"

/** A directory setting given as text, and where it came from, for error messages. */
export type GivenDirectory = { text: string; source: string }

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
