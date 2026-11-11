import {
  ToolError,
  type OptionType,
  type ToolOptions,
  type ToolOptionValue,
  type ToolSettings,
  type Toolsets,
} from "../core"
import { PROJECT } from "../project"
import type { GivenDirectory } from "./directory"
import { resolveDownloadDir } from "./download-dir"
import { PROJECT_PROFILE, type EntryProfile } from "./profile"
import { resolveSendDirs } from "./send-dirs"
import { resolveStateDir } from "./state-dir"

/** Who asks the person before an administrative tool acts: the harness, or the tool through the client's form. */
export type ConfirmMode = "harness" | "elicitation"

/**
 * The settings needed to run tools: tool selection, read-only mode, the resolved state and download settings, the
 * two the sync service takes (off when absent) and the values of the package's own settings (`options`, possibly
 * empty).
 */
export type RunSettings = ToolSettings & {
  options: ToolOptions
  state_dir: string
  download_dir: string
  download_max_mb: number
  /** The directories files may be sent from, besides the working directory: absolute paths. */
  send_dirs: string[]
  /** Whether messages that disappear are kept. */
  keep_disappearing?: boolean
  /** Whether channels are listed and their messages received. */
  channels?: boolean
}

export type EntrySettings = RunSettings & { confirm: ConfirmMode }

const CONFIRM_MODES: readonly ConfirmMode[] = ["harness", "elicitation"]
const ALL_TOOLSETS = "all"
const TRUE_VALUES: readonly string[] = ["1", "true"]
const FALSE_VALUES: readonly string[] = ["0", "false"]
const DEFAULT_DOWNLOAD_MAX_MB = 100
const MAX_DOWNLOAD_MB = 2000

type OptionName =
  | "toolsets"
  | "read_only"
  | "tools"
  | "exclude_tools"
  | "confirm"
  | "state_dir"
  | "download_dir"
  | "download_max_mb"
  | "send_dirs"
  | "keep_disappearing"
  | "channels"

/** A setting's command-line flag and the end of its environment variable, which follows the profile's prefix; a boolean flag takes no value. */
type Option = { flag: string; envSuffix: string; boolean?: true }

const OPTIONS: Record<OptionName, Option> = {
  toolsets: { flag: "--toolsets", envSuffix: "TOOLSETS" },
  read_only: { flag: "--read-only", envSuffix: "READ_ONLY", boolean: true },
  tools: { flag: "--tools", envSuffix: "TOOLS" },
  exclude_tools: { flag: "--exclude-tools", envSuffix: "EXCLUDE_TOOLS" },
  confirm: { flag: "--confirm", envSuffix: "CONFIRM" },
  state_dir: { flag: "--state-dir", envSuffix: "STATE_DIR" },
  download_dir: { flag: "--download-dir", envSuffix: "DOWNLOAD_DIR" },
  download_max_mb: { flag: "--download-max-mb", envSuffix: "DOWNLOAD_MAX_MB" },
  send_dirs: { flag: "--send-dirs", envSuffix: "SEND_DIRS" },
  keep_disappearing: { flag: "--keep-disappearing", envSuffix: "KEEP_DISAPPEARING", boolean: true },
  channels: { flag: "--channels", envSuffix: "CHANNELS", boolean: true },
}

/** The two boolean settings the sync service takes. */
const SERVICE_OPTION_NAMES = ["keep_disappearing", "channels"] as const satisfies readonly OptionName[]

function profileOptions(profile: EntryProfile): NonNullable<EntryProfile["options"]> {
  return profile.options ?? {}
}

function settingOptions(profile: EntryProfile): Record<string, Option> {
  const toolOptions = Object.entries(profileOptions(profile)).map(([name, kind]): [string, Option] => [
    name,
    {
      flag: `--${name.replace(/_/g, "-")}`,
      envSuffix: name.toUpperCase(),
      ...(kind === "boolean" && { boolean: true as const }),
    },
  ])
  return { ...OPTIONS, ...Object.fromEntries(toolOptions) }
}

function envName(name: string, profile: EntryProfile): string {
  return `${profile.envPrefix}_${settingOptions(profile)[name]!.envSuffix}`
}

/** The environment variables the settings are read from, in the order the settings are listed. */
export function settingVariables(profile: EntryProfile = PROJECT_PROFILE): string[] {
  return Object.keys(settingOptions(profile)).map((name) => envName(name, profile))
}

/** The environment variables a harness that forwards only named variables must pass the server: the settings' variables, then the package's `toolVariables`. */
export function forwardedVariables(
  profile: EntryProfile = PROJECT_PROFILE,
  toolVariables: readonly string[] = PROJECT.toolVariables,
): string[] {
  return [...settingVariables(profile), ...toolVariables]
}

function readFlags(argv: string[], profile: EntryProfile): Record<string, string> {
  const byFlag = new Map(
    Object.entries(settingOptions(profile)).map(([name, option]) => [option.flag, { name, ...option }]),
  )
  const given: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const equals = arg.indexOf("=")
    const flag = equals === -1 ? arg : arg.slice(0, equals)
    const option = byFlag.get(flag)
    if (!arg.startsWith("--") || !option) throw new ToolError("invalid_argument", `Unknown option "${arg}".`)
    if (option.boolean) {
      if (equals !== -1) throw new ToolError("invalid_argument", `Option ${flag} takes no value.`)
      given[option.name] = "true"
      continue
    }
    const value = equals === -1 ? argv[++i] : arg.slice(equals + 1)
    if (value === undefined || (equals === -1 && value.startsWith("--"))) {
      throw new ToolError("invalid_argument", `Option ${flag} needs a value.`)
    }
    given[option.name] = value
  }
  return given
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
}

function checkToolsets(names: string[], source: string, toolsets: Toolsets): string[] | "all" | undefined {
  if (names.includes(ALL_TOOLSETS)) return ALL_TOOLSETS
  const unknown = names.find((name) => !toolsets.names.includes(name))
  if (unknown !== undefined) {
    const known =
      toolsets.names.length > 0
        ? `use one of ${toolsets.names.join(", ")} or "${ALL_TOOLSETS}"`
        : "no toolsets are defined"
    throw new ToolError("invalid_argument", `Unknown toolset "${unknown}" in ${source}; ${known}.`)
  }
  return names.length ? names : undefined
}

function parseBoolean(value: string, source: string): boolean {
  const text = value.trim().toLowerCase()
  if (TRUE_VALUES.includes(text)) return true
  if (FALSE_VALUES.includes(text)) return false
  throw new ToolError(
    "invalid_argument",
    `Unknown value "${value}" in ${source}; use one of ${[...TRUE_VALUES, ...FALSE_VALUES].join(", ")}.`,
  )
}

function parseConfirm(value: string, source: string): ConfirmMode {
  const mode = CONFIRM_MODES.find((candidate) => candidate === value)
  if (!mode) {
    throw new ToolError(
      "invalid_argument",
      `Unknown confirm mode "${value}" in ${source}; use one of ${CONFIRM_MODES.join(", ")}.`,
    )
  }
  return mode
}

function parseNumber(value: string, source: string): number {
  const trimmed = value.trim()
  const parsed = trimmed === "" ? Number.NaN : Number(trimmed)
  if (!Number.isFinite(parsed)) {
    throw new ToolError("invalid_argument", `Unknown number "${value}" in ${source}; use a finite number.`)
  }
  return parsed
}

/** A setting given as text, and where it came from, for error messages. */
type SettingText = GivenDirectory

/** A comma-separated directory setting as one entry per directory, each keeping where it came from. */
function listedDirectories(given: SettingText | undefined): GivenDirectory[] {
  return given === undefined ? [] : splitList(given.text).map((text) => ({ text, source: given.source }))
}

function downloadMaxMb(value: unknown, source: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_DOWNLOAD_MB) {
    throw new ToolError("invalid_argument", `${source} must be an integer from 1 to ${MAX_DOWNLOAD_MB}.`)
  }
  return value
}

/** `download_max_mb` given as text: digits only, so `1e2` or `0x10` is not read as a number. */
function downloadMaxMbText({ text, source }: SettingText): number {
  const trimmed = text.trim()
  return downloadMaxMb(/^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN, source)
}

/** The resolved download settings, read by tools rather than the sync service. */
export function downloadSettings(
  given: ((name: "download_dir" | "download_max_mb") => SettingText | undefined) | undefined,
  env: Record<string, string | undefined>,
  profile: EntryProfile,
): Pick<RunSettings, "download_dir" | "download_max_mb"> {
  const value = given ?? ((name) => envText(name, env, profile))
  const max = value("download_max_mb")
  return {
    download_dir: resolveDownloadDir(value("download_dir"), env, profile),
    download_max_mb: max === undefined ? DEFAULT_DOWNLOAD_MAX_MB : downloadMaxMbText(max),
  }
}

function envText(
  name: string,
  env: Record<string, string | undefined>,
  profile: EntryProfile,
): SettingText | undefined {
  const variable = envName(name, profile)
  const text = env[variable]
  return text === undefined || text.trim() === "" ? undefined : { text, source: variable }
}

/** A setting from the command line when its flag was given, else from its environment variable. */
function flagOrEnvText(
  flags: Partial<Record<OptionName, string>>,
  name: OptionName,
  env: Record<string, string | undefined>,
  profile: EntryProfile,
): SettingText | undefined {
  const flagged = flags[name]
  return flagged !== undefined ? { text: flagged, source: OPTIONS[name].flag } : envText(name, env, profile)
}

function parseOptionText(kind: OptionType, given: SettingText): ToolOptionValue | undefined {
  switch (kind) {
    case "text":
      return nonBlank(given.text)
    case "boolean":
      return parseBoolean(given.text, given.source)
    case "number":
      return parseNumber(given.text, given.source)
    case "list": {
      const items = splitList(given.text)
      return items.length > 0 ? items : undefined
    }
  }
}

function optionsFrom(
  flags: Record<string, string>,
  env: Record<string, string | undefined>,
  profile: EntryProfile,
): ToolOptions {
  const options: Record<string, ToolOptionValue> = {}
  for (const [name, kind] of Object.entries(profileOptions(profile))) {
    if (flags[name] !== undefined) {
      if (kind === "text") {
        const text = nonBlank(flags[name])
        if (text !== undefined) options[name] = text
        continue
      }
      if (kind === "list") {
        const items = splitList(flags[name])
        if (items.length > 0) options[name] = items
        continue
      }
      const parsed = parseOptionText(kind, { text: flags[name], source: settingOptions(profile)[name]!.flag })
      if (parsed !== undefined) options[name] = parsed
      continue
    }
    const fromEnv = envText(name, env, profile)
    if (fromEnv !== undefined) {
      const parsed = parseOptionText(kind, fromEnv)
      if (parsed !== undefined) options[name] = parsed
    }
  }
  return options
}

export function parseToolOptions(
  argv: string[],
  env: Record<string, string | undefined>,
  profile: EntryProfile = PROJECT_PROFILE,
): ToolOptions {
  const flags = readFlags(argv, profile)
  const known = profileOptions(profile)
  const other = Object.keys(flags).find((name) => !(name in known))
  if (other !== undefined) {
    throw new ToolError("invalid_argument", `Unknown option "${settingOptions(profile)[other]!.flag}".`)
  }
  return optionsFrom(flags, env, profile)
}

/**
 * Reads the settings every entry point takes from its command line and
 * environment (`<envPrefix>_<SETTING>` variables). A flag wins over its
 * environment variable; an empty list item is dropped. A mistake is
 * `invalid_argument` naming the culprit.
 */
export function parseSettings(
  argv: string[],
  env: Record<string, string | undefined>,
  profile: EntryProfile = PROJECT_PROFILE,
): EntrySettings {
  const flags = readFlags(argv, profile)
  const value = (name: OptionName): SettingText | undefined => flagOrEnvText(flags, name, env, profile)

  const settings: EntrySettings = {
    confirm: "harness",
    options: optionsFrom(flags, env, profile),
    state_dir: resolveStateDir(value("state_dir"), env, profile),
    ...downloadSettings(value, env, profile),
    send_dirs: resolveSendDirs(listedDirectories(value("send_dirs")), env),
  }
  const toolsets = value("toolsets")
  if (toolsets) settings.toolsets = checkToolsets(splitList(toolsets.text), toolsets.source, profile.toolsets)
  const readOnly = value("read_only")
  if (readOnly) settings.read_only = parseBoolean(readOnly.text, readOnly.source)
  const tools = value("tools")
  if (tools) settings.tools = splitList(tools.text)
  const excluded = value("exclude_tools")
  if (excluded) settings.exclude_tools = splitList(excluded.text)
  const confirm = value("confirm")
  if (confirm) settings.confirm = parseConfirm(confirm.text.trim(), confirm.source)
  for (const name of SERVICE_OPTION_NAMES) {
    const given = value(name)
    if (given) settings[name] = parseBoolean(given.text, given.source)
  }
  return settings
}

/**
 * Reads the tool settings from a command line that has no `confirm` setting,
 * for entry points whose caller does the confirming: `--confirm` is
 * `invalid_argument`, and `<envPrefix>_CONFIRM` is ignored. Everything else
 * is read as `parseSettings` reads it.
 */
export function parseToolSettings(
  argv: string[],
  env: Record<string, string | undefined>,
  profile: EntryProfile = PROJECT_PROFILE,
): RunSettings {
  const { flag } = OPTIONS.confirm
  if (argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`))) {
    throw new ToolError("invalid_argument", `Option ${flag} is not available here.`)
  }
  const { confirm: _confirm, ...settings } = parseSettings(
    argv,
    { ...env, [envName("confirm", profile)]: undefined },
    profile,
  )
  return settings
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
  const flags = readFlags(argv, profile)
  const other = Object.keys(flags).find((name) => name !== "state_dir")
  if (other !== undefined) {
    throw new ToolError("invalid_argument", `Option ${settingOptions(profile)[other]!.flag} is not available here.`)
  }
  return resolveStateDir(flagOrEnvText(flags, "state_dir", env, profile), env, profile)
}

/** What the sync service and its service unit take from the command line: the state directory and two booleans. */
export type ServiceSettings = { state_dir: string; keep_disappearing: boolean; channels: boolean }

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
  const flags = readFlags(argv, profile)
  const allowed: readonly string[] = ["state_dir", ...SERVICE_OPTION_NAMES]
  const other = Object.keys(flags).find((name) => !allowed.includes(name))
  if (other !== undefined) {
    throw new ToolError("invalid_argument", `Option ${settingOptions(profile)[other]!.flag} is not available here.`)
  }
  const value = (name: OptionName): SettingText | undefined => flagOrEnvText(flags, name, env, profile)
  const on = (name: (typeof SERVICE_OPTION_NAMES)[number]): boolean => {
    const given = value(name)
    return given !== undefined && parseBoolean(given.text, given.source)
  }
  return {
    state_dir: resolveStateDir(value("state_dir"), env, profile),
    keep_disappearing: on("keep_disappearing"),
    channels: on("channels"),
  }
}

const TOOL_OPTION_NAMES = [
  "toolsets",
  "read_only",
  "tools",
  "exclude_tools",
  "state_dir",
  "download_dir",
  "download_max_mb",
  "send_dirs",
  ...SERVICE_OPTION_NAMES,
] as const satisfies readonly OptionName[]
type ToolOptionName = (typeof TOOL_OPTION_NAMES)[number]

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string") ? value : undefined
}

const optionSource = (name: string): string => `Option "${name}"`

function optionError(name: string, expected: string): ToolError {
  return new ToolError("invalid_argument", `${optionSource(name)} must be ${expected}.`)
}

function directoryOption(name: "state_dir" | "download_dir", value: unknown): string {
  if (typeof value !== "string") throw optionError(name, "an absolute path")
  return value
}

function sendDirsOption(value: unknown): GivenDirectory[] {
  const list = stringList(value)
  if (!list) throw optionError("send_dirs", "a list of absolute paths")
  return list.map((text) => ({ text, source: optionSource("send_dirs") }))
}

function toolsetsOption(value: unknown, toolsets: Toolsets): string[] | "all" | undefined {
  if (value === ALL_TOOLSETS) return ALL_TOOLSETS
  const names = stringList(value)
  if (!names) throw optionError("toolsets", `a list of toolset names or "${ALL_TOOLSETS}"`)
  return checkToolsets(names, 'option "toolsets"', toolsets)
}

function booleanOption(name: OptionName): (value: unknown) => boolean {
  return (value) => {
    if (typeof value !== "boolean") throw optionError(name, "true or false")
    return value
  }
}

function listOption(name: "tools" | "exclude_tools"): (value: unknown) => string[] {
  return (value) => {
    const list = stringList(value)
    if (!list) throw optionError(name, "a list of tool ids")
    return list
  }
}

const LANGUAGE_OPTION = "language"
function pluginOptionNames(profile: EntryProfile): readonly string[] {
  return [...TOOL_OPTION_NAMES, LANGUAGE_OPTION, ...Object.keys(profileOptions(profile))]
}

/** The environment variable of the `language` setting: `<envPrefix>_LANGUAGE`. */
export function languageVariable(profile: EntryProfile = PROJECT_PROFILE): string {
  return `${profile.envPrefix}_LANGUAGE`
}

/** The run settings plus the language of a native plugin's approval prompt, as given (matched later against the package's translations). */
export type PluginSettings = RunSettings & { language?: string }

function nonBlank(text: string | undefined): string | undefined {
  const trimmed = text?.trim()
  return trimmed === "" ? undefined : trimmed
}

/** The language of the prompt from a command line's `--language` value, else `<envPrefix>_LANGUAGE`, else the harness's own display language; blank values count as unset. */
export function promptLanguage(
  flag: string | undefined,
  env: Record<string, string | undefined>,
  harness: string | undefined,
  profile: EntryProfile = PROJECT_PROFILE,
): string | undefined {
  return nonBlank(flag) ?? nonBlank(env[languageVariable(profile)]) ?? nonBlank(harness)
}

function languageOption(value: unknown): string | undefined {
  if (typeof value !== "string") throw optionError(LANGUAGE_OPTION, 'a language tag such as "ja"')
  return nonBlank(value)
}

function toolOption(name: string, kind: OptionType, value: unknown): ToolOptionValue | undefined {
  switch (kind) {
    case "text":
      if (typeof value !== "string") throw optionError(name, "text")
      return nonBlank(value)
    case "boolean":
      if (typeof value !== "boolean") throw optionError(name, "true or false")
      return value
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) throw optionError(name, "a finite number")
      return value
    case "list": {
      const list = stringList(value)
      if (!list) throw optionError(name, "a list of strings")
      const items = list.map((item) => item.trim()).filter((item) => item !== "")
      return items.length > 0 ? items : undefined
    }
  }
}

/**
 * Reads the tool settings and the prompt language from the options a plugin
 * is configured with, for entry points that have no command line. An option
 * wins over its environment variable (`language` falls back to
 * `<envPrefix>_LANGUAGE`, blank meaning unset, and is not checked against any
 * list); an option of the wrong type, or one this function does not know, is
 * `invalid_argument` naming it. `confirm` is not an option here: the harness
 * asks.
 */
export function settingsFromOptions(
  options: Record<string, unknown> | undefined,
  env: Record<string, string | undefined>,
  profile: EntryProfile = PROJECT_PROFILE,
): PluginSettings {
  const given = options ?? {}
  const names = pluginOptionNames(profile)
  const unknown = Object.keys(given).find((name) => !names.includes(name))
  if (unknown !== undefined) {
    throw new ToolError("invalid_argument", `Unknown option "${unknown}"; use one of ${names.join(", ")}.`)
  }

  const resolve = <T>(
    name: ToolOptionName,
    fromOption: (value: unknown) => T,
    fromText: (text: SettingText) => T,
  ): T | undefined => {
    if (given[name] !== undefined) return fromOption(given[name])
    const text = envText(name, env, profile)
    return text !== undefined ? fromText(text) : undefined
  }

  const parsedOptions: Record<string, ToolOptionValue> = {}
  for (const [name, kind] of Object.entries(profileOptions(profile))) {
    let parsed: ToolOptionValue | undefined
    if (given[name] !== undefined) {
      parsed = toolOption(name, kind, given[name])
    } else {
      const fromEnv = envText(name, env, profile)
      if (fromEnv !== undefined) parsed = parseOptionText(kind, fromEnv)
    }
    if (parsed !== undefined) parsedOptions[name] = parsed
  }
  const directoryText = (name: "state_dir" | "download_dir"): SettingText | undefined =>
    given[name] !== undefined
      ? { text: directoryOption(name, given[name]), source: optionSource(name) }
      : envText(name, env, profile)
  const settings: PluginSettings = {
    options: parsedOptions,
    state_dir: resolveStateDir(directoryText("state_dir"), env, profile),
    send_dirs: resolveSendDirs(resolve("send_dirs", sendDirsOption, listedDirectories) ?? [], env),
    download_dir: resolveDownloadDir(directoryText("download_dir"), env, profile),
    download_max_mb:
      resolve("download_max_mb", (value) => downloadMaxMb(value, optionSource("download_max_mb")), downloadMaxMbText) ??
      DEFAULT_DOWNLOAD_MAX_MB,
  }
  const toolsets = resolve(
    "toolsets",
    (value) => toolsetsOption(value, profile.toolsets),
    ({ text, source }) => checkToolsets(splitList(text), source, profile.toolsets),
  )
  if (toolsets !== undefined) settings.toolsets = toolsets
  const readOnly = resolve("read_only", booleanOption("read_only"), ({ text, source }) => parseBoolean(text, source))
  if (readOnly !== undefined) settings.read_only = readOnly
  for (const name of SERVICE_OPTION_NAMES) {
    const given = resolve(name, booleanOption(name), ({ text, source }) => parseBoolean(text, source))
    if (given !== undefined) settings[name] = given
  }
  const tools = resolve("tools", listOption("tools"), ({ text }) => splitList(text))
  if (tools !== undefined) settings.tools = tools
  const excluded = resolve("exclude_tools", listOption("exclude_tools"), ({ text }) => splitList(text))
  if (excluded !== undefined) settings.exclude_tools = excluded
  const language =
    given[LANGUAGE_OPTION] !== undefined
      ? languageOption(given[LANGUAGE_OPTION])
      : promptLanguage(undefined, env, undefined, profile)
  if (language !== undefined) settings.language = language
  return settings
}
