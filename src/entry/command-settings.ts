import { resolveDirectorySettings } from "./directory"
import { PROJECT_PROFILE, type EntryProfile } from "./profile"
import { parseToolOptions } from "./settings"

/** The settings the commands that select no tools take besides the state directory: the sync service's two booleans. */
const SERVICE_BOOLEANS = ["keep_disappearing", "channels"] as const
const STATE_DIR = "state_dir"

/** What the sync service and its service unit take from the command line: the state directory and two booleans. */
export type ServiceSettings = { state_dir: string; keep_disappearing: boolean; channels: boolean }

/** The profile with only the named tool options declared, so a flag for any other setting is unknown. */
function onlyOptions(profile: EntryProfile, names: readonly string[]): EntryProfile {
  const declared = Object.entries(profile.options ?? {}).filter(([name]) => names.includes(name))
  return { ...profile, options: Object.fromEntries(declared) }
}

/**
 * Reads only the `state_dir` setting from a command line that takes no other
 * setting, for commands that select no tools: any other settings flag is
 * `invalid_argument`. The flag wins over its environment variable.
 */
export function parseStateDir(
  argv: string[],
  env: Record<string, string | undefined>,
  profile: EntryProfile = PROJECT_PROFILE,
): string {
  const options = parseToolOptions(argv, env, onlyOptions(profile, [STATE_DIR]))
  return resolveDirectorySettings(options, env, profile).state_dir
}

/**
 * Reads the settings of the commands that run or install the sync service
 * from their remaining flags: the state directory, `--keep-disappearing` and
 * `--channels` (flag over `<envPrefix>_*`, both off by default). Any other
 * settings flag is `invalid_argument`.
 */
export function parseServiceSettings(
  argv: string[],
  env: Record<string, string | undefined>,
  profile: EntryProfile = PROJECT_PROFILE,
): ServiceSettings {
  const options = parseToolOptions(argv, env, onlyOptions(profile, [STATE_DIR, ...SERVICE_BOOLEANS]))
  return {
    state_dir: resolveDirectorySettings(options, env, profile).state_dir,
    keep_disappearing: options.keep_disappearing === true,
    channels: options.channels === true,
  }
}
