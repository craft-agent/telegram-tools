import { resolve } from "node:path"
import { homeDir, resolveGivenDirectory, type GivenDirectory } from "./directory"
import type { EntryProfile } from "./profile"

/** The folder of a person's downloads under their home directory. */
const DOWNLOADS_DIR = "Downloads"

/** Resolves the received-files directory, expanding `~`, or defaulting to `<home>/Downloads/<profile.name>`. */
export function resolveDownloadDir(
  given: GivenDirectory | undefined,
  env: Record<string, string | undefined>,
  profile: EntryProfile,
): string {
  const home = homeDir(env)
  return given !== undefined ? resolveGivenDirectory(given, home) : resolve(home, DOWNLOADS_DIR, profile.name)
}
