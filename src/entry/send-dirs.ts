import { homeDir, resolveGivenDirectory, type GivenDirectory } from "./directory"

/**
 * Resolves the directories files may be sent from, besides the working
 * directory: each given entry has a leading `~` expanded and must be absolute
 * after that, else `invalid_argument` names its source. None given is none.
 */
export function resolveSendDirs(given: GivenDirectory[], env: Record<string, string | undefined>): string[] {
  const home = homeDir(env)
  return given.map((directory) => resolveGivenDirectory(directory, home))
}
