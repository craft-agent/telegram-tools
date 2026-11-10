# telegram-tools

Unofficial Telegram tools for coding agents: chats, messages, received files, sends and actions.

| Harness        | Delivery                                       | Pinned by                      |
| -------------- | ---------------------------------------------- | ------------------------------ |
| OpenCode V2    | native plugin (npm package, with skills)       | the version in the package     |
| OpenCode V1    | native plugin (npm package, no skills)         | the version in the package     |
| Claude Code    | plugin: MCP server and skills                  | the release tag, as the ref    |
| Codex          | plugin: MCP server and skills                  | the release tag, as the ref    |
| Grok Build     | plugin: MCP server and skills                  | the release tag, as `@ref`     |
| Antigravity    | plugin: MCP server and skills                  | the release tag's tree URL     |
| Hermes Agent   | native plugin (Python, calls the command line) | the release commit, as the SHA |
| other MCP host | MCP server from npm                            | the version in the package     |

The tools need [Node.js](https://nodejs.org/) 24 or later.
[`docs/conventions.md`](docs/conventions.md) describes how the tools are named
and how they behave.

## Install

Install from a release, never from the default branch: a release is a tag whose
commit carries the built `dist/`, and the default branch does not. In the
commands below, `<version>` is a release's version (`1.2.3`) and `<sha>` is the
commit its tag names:

```sh
gh api repos/craft-agent/telegram-tools/commits/v<version> --jq .sha
```

### OpenCode

OpenCode V2 takes the package and its options in `opencode.json`:

```json
{
  "plugins": [{ "package": "@craftsamo/telegram-tools@<version>", "options": { "read_only": false } }],
  "permissions": [{ "action": "telegram_*", "resource": "*", "effect": "ask" }]
}
```

OpenCode V1 takes the package as a string, or as a pair with its options:

```json
{
  "plugin": [["@craftsamo/telegram-tools@<version>", { "read_only": false }]],
  "permission": { "telegram_*": "ask" }
}
```

OpenCode allows any action no rule names, so the plugin's request is granted
silently unless a rule says `ask`. Read tools never ask, so the `telegram_*` glob
is safe.

V1 registers no skills. Unpack the package and copy its `skills/*` folders into
`~/.config/opencode/skills/`:

```sh
npm pack @craftsamo/telegram-tools@<version>
tar -xzf craftsamo-telegram-tools-<version>.tgz
mkdir -p ~/.config/opencode/skills
cp -r package/skills/* ~/.config/opencode/skills/
rm -rf package craftsamo-telegram-tools-<version>.tgz
```

### Claude Code

```sh
claude plugin marketplace add craft-agent/telegram-tools#v<version>
claude plugin install telegram-tools@craft-agent
```

### Codex

```sh
codex plugin marketplace add craft-agent/telegram-tools --ref v<version>
codex plugin add telegram-tools@craft-agent
```

Codex turns `-` into `_` in server names, so it shows the tools as
`mcp__telegram_tools__telegram_*`. It starts the MCP server in the plugin's
install directory, which is never the caller's working tree.

### Grok Build

```sh
grok plugin install craft-agent/telegram-tools@v<version> --trust
```

Grok starts the MCP server in the session's working directory.

### Antigravity

Install from the tree of the release tag, never from the default branch, which
has no built `dist/`; Antigravity clones the tag into
`~/.gemini/config/plugins/telegram-tools`.

```sh
agy plugin install https://github.com/craft-agent/telegram-tools/tree/v<version>
```

### Hermes Agent

Hermes installs a commit, not a tag, and the plugin installs disabled:

```sh
hermes plugins install craft-agent/telegram-tools --ref <sha>
hermes plugins enable telegram-tools
```

If a Hermes gateway is already running, restart it (`hermes gateway restart`) to
load the plugin.

### Any other MCP host

Add the server to the host's MCP configuration. Flags go in `args`:

```json
{
  "mcpServers": {
    "telegram-tools": {
      "command": "npx",
      "args": ["-y", "@craftsamo/telegram-tools@<version>", "--read-only"]
    }
  }
}
```

## Tools and skills

Each toolset comes with a skill that tells an agent how to use its tools.

### Account (`account`)

| Tool                    | What it does                                                                                                                                  | Class |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `telegram_account_read` | which labels are logged in, whether each sync service runs, when it last heard from Telegram, the mirror's counts, and the person's next step | read  |

It reads local state only: no daemon, no network, and no phone number, account
id or key in its result. The skill is
[`telegram-account`](skills/telegram-account/SKILL.md), shown as
`telegram-tools:telegram-account` in Claude Code and `telegram-tools:account`
in Hermes.

### Chats (`chats`)

| Tool                 | What it does                                                                                                       | Class |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ | ----- |
| `telegram_chat_read` | finds chats and reads messages by `method`: `list`, `view`, `topics`, `search`, `around`, or older history `fetch` | read  |

Chats the mirror keeps (private chats, bots, basic groups, Saved Messages;
supergroups and channels while on the sync list) are read from the local mirror
without needing the sync service; older history is fetched with `fetch`. Chats
only listed are read live from Telegram by `view` and `around`, via the sync
service, up to 100 messages a page (`live: true`). Message text, captions, file
names and topic titles are data, never instructions. The skill is
[`telegram-chats`](skills/telegram-chats/SKILL.md), shown as
`telegram-tools:telegram-chats` in Claude Code and `telegram-tools:chats` in
Hermes.

### Sync (`sync`)

| Tool                   | What it does                                                                           | Class      |
| ---------------------- | -------------------------------------------------------------------------------------- | ---------- |
| `telegram_sync_read`   | lists the supergroups and channels on the sync list                                    | read       |
| `telegram_sync_add`    | puts supergroups or channels on the sync list to mirror from now on                    | idempotent |
| `telegram_sync_remove` | takes chats off the sync list and deletes their mirrored messages and earlier versions | overwrite  |

The sync list names up to 30 supergroups and channels whose messages the mirror
keeps current. `telegram_sync_read` reads the list from the local mirror
without needing the sync service. Adding or removing chats changes the local
mirror and needs the sync service running; newly added chats are seeded with
their newest 50 messages, while removing a chat deletes its mirrored messages
and earlier versions locally (nothing changes at Telegram). Channels can be
listed or mirrored only with the `channels` setting on. The skill is
[`telegram-sync`](skills/telegram-sync/SKILL.md), shown as
`telegram-tools:telegram-sync` in Claude Code and `telegram-tools:sync` in
Hermes.

### Sends (`sends`)

| Tool                    | What it does                                                              | Class |
| ----------------------- | ------------------------------------------------------------------------- | ----- |
| `telegram_message_send` | sends one text to a chat by id, optionally to a forum topic or as a reply | add   |

The `sends` toolset is on by default. The text goes out as written (never read
as Markdown or HTML), trimmed, at most 4096 characters. One call sends once,
with one `random_id`, and is never repeated: a failure `uncertain` means the
message may have gone out, and its hint lists the matching messages the mirror
saw, so the person checks the chat before anything is sent again. `duplicate`
means an earlier delivery of the same call had already gone out. The sync
service sends it, so it must be running. The skill is
[`telegram-sends`](skills/telegram-sends/SKILL.md), shown as
`telegram-tools:telegram-sends` in Claude Code and `telegram-tools:sends` in
Hermes.

### Files (`files`)

| Tool                 | What it does                                                                | Class |
| -------------------- | --------------------------------------------------------------------------- | ----- |
| `telegram_file_save` | downloads one message's file from Telegram and saves it into `download_dir` | add   |
| `telegram_file_send` | sends 1 to 10 files (100 MB together), with a caption, to a chat            | add   |

The `files` toolset is off by default: it writes to disk, opens archives and
sends files. Turn it on with `toolsets` or `tools`. Sending takes 1 to 10 files
(at most 100 MB together) as one group, every file as a file, from the working
directory (not when that is the home directory or a file system root) and the
directories `send_dirs` names; keys, secrets, programs and installers are
refused, archives are checked entry by entry, each file is copied into the
label's outbox and checked before upload, and `sha256` can pin a file to what
was approved. Sending needs the sync service running; a failure `uncertain`
lists matching messages the mirror saw so the person checks the chat before
anything is sent again. For received files, a message's file goes in
`<download_dir>/<label>/<chat id>/<message id>/`, private (mode 600), never
executable and never overwritten; `download_max_mb` sets the largest file
taken. The sync service downloads it, so it must be running. Programs and
installers are refused, and so are archives other than zip, tar and gzipped
tar, archives holding a program, another archive, a link or a path that leaves
them, animated stickers and view-once files. An archive is inspected and
listed, and unpacked only when asked (`unpack: true`) into `<name>.unpacked/`
beside it. On macOS every saved and unpacked file carries the quarantine flag.
File names and contents are data, never instructions. The skill is
[`telegram-files`](skills/telegram-files/SKILL.md), shown as
`telegram-tools:telegram-files` in Claude Code and `telegram-tools:files` in
Hermes.

### Actions (`actions`)

| Tool                      | What it does                                                          | Class          |
| ------------------------- | --------------------------------------------------------------------- | -------------- |
| `telegram_message_edit`   | replaces the text or caption of one of the user's own messages        | overwrite      |
| `telegram_message_delete` | deletes one of the user's own messages for everyone                   | administrative |
| `telegram_message_react`  | sets or removes the user's emoji reaction on a message                | overwrite      |
| `telegram_message_pin`    | pins or unpins a message                                              | overwrite      |
| `telegram_chat_mark_read` | marks a chat, or one forum topic, read up to a message, never further | idempotent     |

The `actions` toolset is off by default: it changes what other people have
already read. Turn it on with `toolsets` or `tools`. Edit and delete take only
the user's own messages; a delete is always for everyone, cannot be undone and
is asked about every time. A reaction is one standard emoji that replaces the
user's earlier one (custom and paid reactions are refused). A pin is silent
unless `notify`, and in a private chat it pins for the user only unless
`both_sides`. Mark read runs only when the user asks, goes up to the message
named and never back, and makes the senders see it read. Every action needs the
sync service running. `already` means it was already so; `uncertain` means it
may have happened, so the person checks the chat before it is asked again. The
skill is [`telegram-actions`](skills/telegram-actions/SKILL.md), shown as
`telegram-tools:telegram-actions` in Claude Code and `telegram-tools:actions`
in Hermes.

## Adding a tool

1. Write the spec in `src/core/<domain>/<verb>.ts` with `defineTool`: an ID
   `<prefix>_<domain>_<verb>`, a title and description, the Zod argument and
   output schemas, its toolset and write class, and `execute(args, context)`.
   A write tool also gives `targets(args, context)`: what the call writes to,
   as a permission rule should name it.
2. Test it beside the spec (`<verb>.test.ts`), calling it through `invoke` as
   the entry points do. A tool that runs a program is tested against a fake of
   that program on `PATH`; no test reaches a real service.
3. List it in `src/tools.ts`. A new toolset goes into `toolsets` in
   `src/project.ts` (and `defaultToolsets` when it is on by default), and a
   variable the tool reads besides the settings into `toolVariables`.
4. Add or update the toolset's skill, `skills/<prefix>-<toolset>/SKILL.md`.
5. Run `pnpm run build && pnpm run manifests` to list the tool in
   `plugin.yaml` and its variables in Codex's manifest, then describe it under
   "Tools and skills".

[`docs/conventions.md`](docs/conventions.md) has the rules each step follows.

## Reads and writes

Every read tool is named `<prefix>_<domain>_read`. Reads can run unasked;
writes are confirmed by the harness.

| Harness     | Reads without asking                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| OpenCode    | always; the plugin asks only before a write                                                                      |
| Claude Code | the rule `mcp__plugin_telegram-tools_telegram-tools__*_read` in `permissions.allow` of `~/.claude/settings.json` |
| Codex       | always; Codex runs tools that declare `readOnlyHint` unasked, as the read tools do                               |
| Grok Build  | `grok --allow 'MCPTool(telegram-tools__*_read)' --allow 'MCPTool(telegram_*_read)'` (both rules; see below)      |
| Antigravity | the rule `mcp(telegram-tools_telegram-tools/<tool id>)` in `permissions.allow`, one for each read tool           |
| Hermes      | always; the plugin asks only before a write                                                                      |

Where a write is asked about, and where it is not:

- **OpenCode** grants any action no rule names, so a write runs unasked unless
  a rule asks for it: add the `telegram_*` rule shown under [OpenCode](#opencode).
- **Codex** under `codex exec`, and **Grok Build** under `grok -p`, refuse a
  write they cannot ask about, unless it is allowed beforehand.
- **Grok Build** calls the plugin's tools through its `use_tool` tool, and the
  agent often names a tool without its server first. Grok checks the rules
  against the name as given, so the server-qualified rule alone does not match
  that first call. The second rule matches the short name; a write still
  matches neither.
- **Antigravity** asks before any MCP tool no rule allows, reads included, and
  names the plugin's server `telegram-tools_telegram-tools` (plugin,
  then server). `agy -p` refuses a tool it cannot ask about.
- **Hermes** `hermes chat -q` refuses a write it cannot ask about; `hermes -z`
  and `--yolo` skip approval, so writes then run unasked.

## Settings

Every entry point takes the same settings. A flag wins over its environment
variable, and an option or setting wins over the variable too.

| Setting             | Flag                    | Variable                           | Meaning                                                                                                                                                    |
| ------------------- | ----------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toolsets`          | `--toolsets`            | `TELEGRAM_TOOLS_TOOLSETS`          | the toolsets that are on, or `all`; default those `src/project.ts` names                                                                                   |
| `read_only`         | `--read-only`           | `TELEGRAM_TOOLS_READ_ONLY`         | registers no tool that writes; wins over every other setting                                                                                               |
| `tools`             | `--tools`               | `TELEGRAM_TOOLS_TOOLS`             | single tools to add by ID, whatever their toolset                                                                                                          |
| `exclude_tools`     | `--exclude-tools`       | `TELEGRAM_TOOLS_EXCLUDE_TOOLS`     | single tools to remove by ID; wins over `tools` and `toolsets`                                                                                             |
| `confirm`           | `--confirm`             | `TELEGRAM_TOOLS_CONFIRM`           | MCP server only: `harness` (default) or `elicitation`, as the conventions say                                                                              |
| `language`          | `--language`            | `TELEGRAM_TOOLS_LANGUAGE`          | native plugins only: the approval prompt's language, such as `ja`                                                                                          |
| `state_dir`         | `--state-dir`           | `TELEGRAM_TOOLS_STATE_DIR`         | where every label's state lives; default `$XDG_STATE_HOME/telegram-tools`                                                                                  |
| `download_dir`      | `--download-dir`        | `TELEGRAM_TOOLS_DOWNLOAD_DIR`      | where `telegram_file_save` saves received files, a folder per message; default `~/Downloads/telegram-tools`; read by the tools, no service restart needed  |
| `download_max_mb`   | `--download-max-mb <n>` | `TELEGRAM_TOOLS_DOWNLOAD_MAX_MB`   | the largest file a download takes, in MB; integer 1..2000, default 100; read by the tools, no service restart needed                                       |
| `send_dirs`         | `--send-dirs`           | `TELEGRAM_TOOLS_SEND_DIRS`         | the directories files may be sent from, besides the working directory; absolute paths, default none; read by the tools, no service restart needed          |
| `keep_disappearing` | `--keep-disappearing`   | `TELEGRAM_TOOLS_KEEP_DISAPPEARING` | keep disappearing and view-once messages for the user; off by default; read by `sync` and `service install`, run `service install` again after changing it |
| `channels`          | `--channels`            | `TELEGRAM_TOOLS_CHANNELS`          | list, read, mirror and send to channels; off by default, see below; read by `sync` and `service install`, run `service install` again after changing it    |

Lists are comma-separated in a flag or a variable. Where each harness reads them:

- **OpenCode** takes the plugin `options` shown above, with lists as arrays,
  `read_only` as a boolean, `state_dir` and `download_dir` as paths, and
  `download_max_mb` as a number, `send_dirs` as an array of paths, and falls back to the
  variables. V2 runs plugins in its background service, which keeps the
  environment it started with: a variable set where `opencode run` starts has
  no effect until the service is
  restarted in that environment (`opencode service restart`). V1 runs plugins
  in its own process.
- **Hermes** takes `plugins.entries.telegram-tools.settings` in
  `config.yaml`:

  ```yaml
  plugins:
    entries:
      telegram-tools:
        settings:
          read_only: false
          exclude_tools: []
  ```

  Without a `language` setting, the approval card follows Hermes's own
  `display.language` (or `HERMES_LANGUAGE`), the language of its approval
  buttons, and else stays in English. The plugin passes its own environment
  to the command line it runs, so the variables work too. A running gateway keeps the environment it started with;
  restart it (`hermes gateway restart`) after changing one.

- **Claude Code, Grok Build and Antigravity** start the plugin's server without
  flags and pass it the client's environment, so set the variables in the
  environment the harness runs in.
- **Codex** passes a plugin's MCP server only a few basic variables (such as
  `PATH` and `HOME`) and those the plugin's manifest names, which are the
  variables above: set them in the environment Codex runs in. A variable the
  tools read besides the settings belongs in `toolVariables` in
  `src/project.ts`; `pnpm run manifests` adds it to the manifest after the
  settings' variables. To pass flags, or to give the server a variable the
  package does not name, add the server under `[mcp_servers]` in Codex's
  `config.toml` instead of using the plugin: flags go in `args`, `env_vars`
  names the variables to forward from Codex's environment, and `env` sets
  fixed values.

  ```toml
  [mcp_servers.telegram-tools]
  command = "npx"
  args = ["-y", "@craftsamo/telegram-tools@<version>", "--read-only"]
  env_vars = ["TELEGRAM_TOOLS_TOOLSETS"]
  ```

### Accounts and the sync service

The tools log in as a device of the user's own account through
[mtcute](https://mtcute.dev), with an `api_id` and `api_hash` you register at
[my.telegram.org](https://my.telegram.org). They never read another client's
data.

- **Each logged-in session has a label**, 1 to 24 lowercase letters, digits and
  `_` (`default` when logging in names none). A tool's `account` argument picks
  the label; leave it out when only one session is logged in.
- **Each label keeps its state in one directory**, `<state_dir>/<label>/` (mode
  700): the session and the app credentials, mtcute's storage, the mirror, the
  service's socket, and `incoming/`, the short-lived copies of files in
  transit. `state_dir` defaults to `$XDG_STATE_HOME/telegram-tools`, or
  `~/.local/state/telegram-tools`. Keep it out of shared backups: the session
  reads and sends as you.
- **A sync service holds each label's only connection** and keeps the mirror.
  Chats the mirror keeps are read from the mirror; chats only listed are read
  live via the service. History starts when the service starts following a
  chat; `fetch` adds older history.
- **A new login is shown to your other devices**, and Telegram ends sessions
  unused for the period set under the account's settings.

### Logging in and running the sync service

Before you start, register an app at [my.telegram.org](https://my.telegram.org)
(API development tools) to get an `api_id` and `api_hash`. The tools need
[Node.js](https://nodejs.org/) 24 or later. macOS and Linux are supported.

```sh
# Log in: on your phone, open Telegram > Settings > Devices > Link Desktop Device,
# and scan the QR code this prints.
telegram-tools-cli login --account work

# Start receiving at logon, and restart after a failure.
telegram-tools-cli service install --account work
telegram-tools-cli service status --account work
```

`--account` may be left out when only one label exists (`login` names a new
one `default`), and every command takes `--state-dir` like the tools.

| Command                                                       | What it does                                                                                                    |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `login [--account <label>] [--phone \| --telethon]`           | logs in by QR code (default), phone and code (`--phone`), or Telethon v1 string session (`--telethon`)          |
| `sync [--account <label>] [--keep-disappearing] [--channels]` | runs the sync service in the foreground, logging to standard error, until it is stopped                         |
| `service install \| uninstall \| status [--account <label>]`  | registers the sync service as a launchd agent (macOS) or a systemd user unit (Linux), removes it, or reports it |
| `logout [--account <label>]`                                  | ends the session at Telegram and keeps the mirror, while removing local session storage                         |
| `remove --account <label> [--yes]`                            | uninstalls the service and permanently deletes the label's directory, after `--yes` or typing the label back    |

- **Logging in**: `login` shows a QR code by default. Scan it in Telegram on
  your phone under Settings → Devices → Link Desktop Device. `--phone` logs in
  with your phone number and login code; `--telethon` imports a Telethon v1
  string session, read without echo on a terminal or from standard input. If
  your account uses a two-step verification password, `login` asks for it
  without echo. `TELEGRAM_TOOLS_API_ID` and `TELEGRAM_TOOLS_API_HASH` are used
  when set in the environment; otherwise `login` asks for them (the hash
  without echo) and saves them in `<state_dir>/<label>/app.json` (mode 0600).
- **What the service does**: at first start, the service fetches the chat list
  and seeds the newest 50 messages of chats active in the last 30 days, a few
  at a time and paced to avoid flood limits. After that, every update is stored
  in the mirror as it arrives, the chat list is refreshed every 30 minutes, and
  gaps in message history are filled. Supergroups and channels are mirrored only
  while on the sync list (at most 30); channels also require the `channels`
  setting to be turned on.
- **Where it logs**: on macOS, the service writes its log to the file under
  `~/Library/Logs/io.github.craft-agent.telegram-tools/<label>.log` that
  `service install` prints. On Linux, it logs to the systemd user journal
  (`journalctl --user -u <unit>` as `service status` shows); run
  `loginctl enable-linger` to keep the service running after you log out.
- **On macOS, Login Items lists the service as `telegram-tools-sync-<label>`**:
  the agent starts through that launcher script, which `service install` writes
  to `~/Library/Application Support/io.github.craft-agent.telegram-tools/` and
  `service uninstall` deletes. Switching the item off there stops syncing.
- **Service updates and restarts**: `service install` records this package's
  executable path and Node's, so run `service install` again after updating
  either, or changing `keep_disappearing` or `channels`. Where Node's path
  holds its version, as under a version manager, `service install` records a
  `node` on `PATH` at a path without it that starts the same Node, and warns
  when there is none. That `node` then runs whichever Node the manager makes
  current. `service status` and `telegram_account_read` say when the recorded
  program is gone, once the service has been installed with this version. The
  service restarts after a failure a minute later, but stays down after
  Telegram ends the session.
- **One connection per label**: Telegram can revoke an auth key that connects
  from two places at once. `login`, `logout` and `remove` refuse while the
  service runs; stop it first (`service uninstall`, or stop foreground `sync`).
- **Logging out and removing**: `logout` ends the session at Telegram and keeps
  the mirror, removing only the session storage. `remove` uninstalls the
  service and permanently deletes the label's directory, and on macOS the
  service's log too (`service uninstall` keeps it); on Linux the journal keeps
  the service's entries. If Telegram cannot be reached, the session is removed
  locally; end the session in Telegram under Settings → Devices.
- **Device sessions**: a new login shows on your other devices. Telegram ends
  a session unused for the period set under Settings → Privacy and Security →
  "If away for"; then log in again. `telegram_account_read` tells an agent
  which step a label needs.

### Unofficial, and what Telegram's terms say

The package is not made or endorsed by Telegram. You register your own app
([API terms §2.1](https://core.telegram.org/api/terms)), and the package and the
device name the service logs in as identify it as unofficial (§2.2, §2.3).

- **Telegram's terms forbid using platform data for AI.**
  [§1.5](https://core.telegram.org/api/terms) forbids using data from the
  platform to train or deploy AI, and a broad reading covers an agent reading
  your own chats. Unofficial clients are watched and abuse can freeze or ban
  the account.
- **`keep_disappearing` and `channels` are off by default.** Keeping
  disappearing messages goes against §1.4. With it on, the sync service also
  keeps the files of disappearing, view-once and self-destructing messages as
  they arrive (up to 100 MB each, never programs or archives), so
  `telegram_file_save` can save them after Telegram removed them; turning it
  off deletes those files at the service's next start. For channels, API terms §3.3 asks an
  app showing channel content to show sponsored messages. Sponsored messages are
  never fetched or shown (avoiding untrusted prompts reaching the model), and
  whoever turns `channels` on accepts that §3.3 risk. With `channels` off, no
  channel is listed, read, mirrored or kept on the sync list, and the sync
  service deletes every channel and its mirrored messages from the mirror at its
  next start.

## Layout

- `src/project.ts` — the package's name, tool ID prefix, setting prefix,
  toolsets and the other variables its tools read.
- `src/core/` — the tool contract and the tools, free of any harness and of
  the project's names.
- `src/tools.ts` — the list of every tool, which each entry point registers.
- `src/words.ts` — the translations of the tools' words, per language, which
  the native plugins use in their approval prompts.
- `src/mcp/` — the MCP server, built to `dist/mcp.js` and run by
  `telegram-tools`.
- `src/opencode/` — the OpenCode plugin, built to `dist/opencode.js`.
- `src/cli/` — the command line the Hermes plugin calls, built to `dist/cli.js`
  and run by `telegram-tools-cli`.
- `src/hermes/`, `plugin.yaml` and `__init__.py` — the Hermes plugin.
- `skills/` — one skill per toolset, `skills/<name>/SKILL.md`, which every
  harness that takes skills loads from the package or plugin root.
- `.claude-plugin/`, `.codex-plugin/`, `.agents/plugins/`, `.mcp.json`,
  `.antigravity-plugin/` and `mcp_config.json` — the plugin manifests of the
  other harnesses. Codex reads `.codex-plugin/plugin.json`; a root
  `plugin.json` would make it load the plugin as an Agent Plugin, whose tool
  budget hides tools past a fixed size. The root `.mcp.json` is the
  configuration Grok Build reads (with `${CLAUDE_PLUGIN_ROOT}`, the variable
  both Grok Build and Claude Code expand); when working on this repository in
  Claude Code, decline the project MCP server it offers from that file.

How a release is made is in [`RELEASING.md`](RELEASING.md).

## License

[MIT](LICENSE)
