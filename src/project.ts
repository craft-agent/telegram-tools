import type { OptionSpec } from "./core"

/** What makes this package itself; a project made from the starter sets these once (the setup script does). */
export const PROJECT = {
  /** The plugin, MCP server and program name. */
  name: "telegram-tools",
  /** The command line the Hermes plugin calls. */
  cli: "telegram-tools-cli",
  /** Every tool ID starts with `<toolPrefix>_`. */
  toolPrefix: "telegram",
  /** Every setting's environment variable is `<envPrefix>_<SETTING>`. */
  envPrefix: "TELEGRAM_TOOLS",
  /** The toolsets, in the order `all` lists them. */
  toolsets: ["account", "chats", "sync", "files", "sends", "actions"] as readonly string[],
  /** The toolsets on when a setting names none. */
  defaultToolsets: ["account", "chats", "sync", "sends"] as readonly string[],
  /** The package's own settings, which the tools themselves read: each snake_case name and its type, with bounds when it needs them. */
  options: {
    /** Where every account's state lives. */
    state_dir: "path",
    /** Where received files are saved. */
    download_dir: "path",
    /** The largest received file a call may download, in megabytes. */
    download_max_mb: { type: "number", integer: true, min: 1, max: 2000 },
    /** The directories files may be sent from, besides the working directory. */
    send_dirs: "paths",
    /** Whether messages that disappear are kept; read by the sync service's commands. */
    keep_disappearing: "boolean",
    /** Whether channels are listed and their messages received; read by the sync service's commands. */
    channels: "boolean",
  } as Readonly<Record<string, OptionSpec>>,
  /** The environment variables the tools read besides the settings, which Codex forwards to the server after them. */
  toolVariables: [] as readonly string[],
} as const
