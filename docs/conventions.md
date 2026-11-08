# Tool conventions

The rules every tool in this package follows, so tools read alike across
domains and harnesses. Each rule carries the reason it was chosen; a change
to a rule changes this file first, with its reason.

## Names

- **Tool IDs are `<prefix>_<domain>_<verb>`**: `<prefix>_note_read` and
  `<prefix>_note_create` for a `note` domain. The prefix is `toolPrefix` in
  `src/project.ts`; it keeps a name unambiguous where a harness lists every
  tool in one namespace. When the domain has a well-known command line,
  follow its word order, so a name maps to a command anyone can look up.
- **The same ID in every entry point.** Permission rules and skills are
  written once, and an ID is a public interface: renaming one is a breaking
  change.
- **Verbs are plain**: `create`, `edit`, `delete`, `add`, `remove`, and these
  with a fixed meaning:

  | Verb      | Means                                                        |
  | --------- | ------------------------------------------------------------ |
  | `read`    | the one read tool of a domain (below)                        |
  | `resolve` | find which object a call means                               |
  | `ensure`  | create when missing, reuse when present; never a second copy |

- **One read tool per domain, one write tool per operation.**
  `<prefix>_<domain>_read` takes a `method` argument (`view`, `list`, …). A
  model picks tools worse as their number grows, and reads share one set of
  annotations, so folding them loses nothing. Writes stay apart because a
  merged write tool would carry its strictest class: creating something would
  ask like overwriting it.
- **Names stay within 40 characters**, so a client prefix such as
  `mcp__<server>__` still fits a 64-character limit. `defineTool` enforces
  the shape and the length; `src/tools.test.ts` enforces the prefix.

## Arguments

- **snake_case**, for arguments and for the keys of a result alike: one style
  for everything a model reads.
- **Lists change through flat arguments**: `add_tags`, `remove_tags`. Shallow
  schemas are read reliably by every model the harnesses run. An argument that
  replaces a whole list, where one is needed, is named for the list (`tags`)
  and its description says it replaces.
- **Unknown arguments are refused.** Every entry point validates the
  arguments as strict, so a misspelt one fails as `invalid_argument` instead
  of being ignored.
- **The tools' own install directory is never the working tree.** A harness
  may start a tool inside the directory the package is installed in.
  `ToolContext.ownDir` names it; a tool that reads the working tree refuses
  to treat that directory as the caller's, saying so.

## Results

- **A tool returns its data as a plain object**, with no `ok` envelope. Each
  entry point renders it: the MCP server as `structuredContent` with the
  tool's `outputSchema` plus the same JSON as text, a native plugin as a JSON
  string.
- **A failure throws.** Every harness then sees a failed call (`isError` over
  MCP) rather than a success that carries an error.
- **One exception: what a call created is never lost.** Once a tool has
  created something, a later step of the same call that fails does not throw.
  The result names what was created and lists the failed steps under
  `errors`, keyed by step (`StepErrors`).
- **Text a tool reads is returned as it is.** Content from files or services
  is data, never instructions; every read tool's description and the skills
  say so. Nothing is wrapped or rewritten.
- **Times are local, with their offset, to the millisecond**:
  `2026-11-07T14:03:12.345+09:00`. A model judges "yesterday" or "this
  morning" by the user's clock, and the offset keeps the instant exact. A time
  argument takes RFC 3339 with an offset, or a date or a time without one
  (`2026-11-07`, `2026-11-07T14:03`), read as local time; a local time a
  clock change skips or repeats is read as JavaScript's `Date` reads it.
- **A list comes in pages.** It takes `limit`, with a default and a largest
  value per method (above the largest is clamped, below 1 refused), and
  `cursor` to continue; a page with more returns `next`, an opaque string to
  pass back as `cursor`. A cursor holds where the page ended, not a count, so
  what arrives between two pages does not shift the next one.
- **A result stays under 50,000 characters of JSON** by returning fewer
  items and a `next`, since some harnesses refuse a result over 60,000. Text
  is never cut to fit, because a cut message reads as what was said: only a
  single item that alone exceeds the budget is cut, and it says so
  (`text_cut: true`).

## Errors

A thrown error carries a `code` a caller can branch on, and a message that
says what to do next.

| Code               | When                                                                       |
| ------------------ | -------------------------------------------------------------------------- |
| `not_found`        | the object does not exist, or the caller cannot see it                     |
| `forbidden`        | the caller lacks the permission the call needs                             |
| `invalid_argument` | the arguments cannot describe a valid call                                 |
| `stale`            | what the call relied on changed before it could finish                     |
| `unauthenticated`  | the service or program the tool calls is not logged in                     |
| `rate_limited`     | the service refused the call for its rate limit                            |
| `declined`         | the person declined a confirmation the tool asked for                      |
| `upstream_error`   | the service or program the tool calls failed; the message carries its text |
| `uncertain`        | a write may have taken effect; check before trying it again                |
| `internal_error`   | a bug in a tool or an entry point, such as a result off its schema         |

A project adds a code to `src/core/errors.ts` and to this table together.

- **Structure the caller needs goes in `details`, not in the message.** When
  fixing the cause takes more than a sentence (the lint violations, the
  findings, the output of a hook), the error carries it as `details`: a JSON
  object with snake_case keys, like a result. A model then reads the fields
  instead of parsing them back out of prose; the message still says what to
  do next on its own.
- **`details` is fixed when the error is made.** `ToolError` keeps a frozen
  JSON copy, so every entry point renders the same value. The copy is what
  JSON makes of it (`undefined` is dropped, `NaN` becomes `null`), and a value
  JSON cannot write at all, such as a cycle or a `BigInt`, fails where it was
  thrown, as a bug, not where it is rendered.
- **Each entry point passes `details` on only when it is set**, so an error
  without it reads as it always did. The MCP server and the command line put
  it beside the code and the message, as `error.details`. The OpenCode and
  Hermes plugins, whose errors are text, append it to `<code>: <message>` as
  JSON on a line of its own.
- The `errors` of a partial result (`StepErrors`) stay `<code>: <message>`
  strings.

## Write classes

Every tool belongs to one class, and the class sets its MCP annotations.
`openWorldHint` is `true` for every tool.

| Class             | Examples                              | `readOnlyHint` | `destructiveHint` | `idempotentHint` |
| ----------------- | ------------------------------------- | -------------- | ----------------- | ---------------- |
| read              | view, list, resolve                   | `true`         | —                 | `true`           |
| add               | create, add                           | `false`        | `false`           | `false`          |
| idempotent change | ensure, adding a tag                  | `false`        | `false`           | `true`           |
| overwrite         | editing a body or title, removing one | `false`        | `true`            | `true`           |
| administrative    | delete, visibility, publishing        | `false`        | `true`            | `false`          |

- **Overwriting counts as destructive**: it loses what was there, and
  harnesses that confirm only destructive tools should still ask before it.
- **A tool takes the strictest class its arguments can reach.**
- **The harness confirms writes.** Every MCP client asks before it runs a
  write tool, so the tool does not ask again by default. Administrative tools
  also carry `_meta["anthropic/requiresUserInteraction"]: true`, which makes
  Claude Code ask even under an allow rule.
- **A native plugin asks the harness's own permission before every non-read
  call**, since the tools a native plugin adds pass through no harness
  approval of their own.
- **It asks for everything the call writes to.** A write tool's `targets`
  resolver names what the call writes to, as the permission rules name it
  (a path, an account, a record). Anything it cannot tell, every tool
  without a resolver, and a target holding `*` or `?` (which a harness would
  store as a pattern) is `*`, and `*` is never stored. An "always" answer then
  covers only what it named, never a write somewhere else.
- **`confirm: "elicitation"` adds the tool's own form** for administrative
  tools, where the client offers form-mode elicitation. It is for people who
  switch the client's approvals off: the tool states what will happen in plain
  words and stops on anything but an accept. Where the client does not offer
  elicitation the setting adds nothing, and the harness's approval is then the
  only confirmation.
- **Annotations are hints, not a boundary.** The `read_only` setting
  (below) is what keeps writes out.

## Toolsets and settings

Every entry point takes the same settings:

- **Toolsets**: one per domain, listed in `src/project.ts` with the ones on by
  default. A small default keeps the model's choice sharp.
- **`read_only`** registers no write tool, and wins over every other setting.
- **`tools` / `exclude_tools`** add or remove single tools; an exclusion wins
  over an inclusion.
- **`confirm`** is `harness` (the default) or `elicitation`; it says who asks
  before an administrative tool acts (see "Write classes"). The default leaves
  the question to the harness, whose approval every user already knows.
- **`state_dir`**: where every account's state lives (see "Accounts and state").

## The core contract

- A tool spec declares its ID, description, argument schema, output schema,
  toolset and write class; every entry point derives the same metadata from
  it. A write tool also declares `targets(args, context)`, which names what
  the call writes to.
- `execute(args, context)` gets the working directory, an abort signal, an
  optional `ownDir` (the directory the tools are installed in, never the
  working tree) and an optional `confirm(request) => Promise<boolean>` hook.
  Nothing in it names a harness. An entry point supplies `confirm` when the
  `elicitation` setting is on; without it the harness's approval stands, and a
  tool that needs a confirmation treats a missing hook as the harness having
  approved the call.
- `src/core/` uses only the `node:*` modules and plain dependencies, never a
  runtime's own globals (`Bun.spawn`, `Bun.file`, …), so the same code runs on
  Node and on Bun. It knows no project either: names, prefixes and toolsets
  come from `src/project.ts` through the entry points.

## Programs a tool runs

- **Every program a tool runs goes through one runner** built on `exec`, with
  an explicit environment: what the program needs to find itself and
  authenticate is passed through, and nothing else, so a stray variable
  cannot redirect a call. Prompts and colors are switched off, so nothing
  waits on a person and output parses the same everywhere.
- **Every variable the tools read besides the settings is named in
  `toolVariables` in `src/project.ts`**, whether a tool reads it itself or
  passes it through to a program. Codex gives a plugin's server only a few
  basic variables (`PATH`, `HOME` and the like) and those its manifest names,
  and `pnpm run manifests` writes that list from the settings and
  `toolVariables`: a variable left out is set everywhere but in Codex.
- **Every call has a time limit**, and a call that is stopped, by that limit
  or by cancellation, has its child process killed: `SIGTERM`, then `SIGKILL`
  after two seconds. A hung program neither holds a harness forever nor
  outlives its call.
- **The runner maps the program's failures to the error codes above.**

## Tests

- Tests sit beside the code they test (`*.test.ts`) and run on `bun test`;
  CI also starts the built MCP server, plugin and command line under Node and
  lists their tools, so a runtime-only API cannot slip in unnoticed.
- No test reaches a real service. A tool that runs a program is tested
  against a fake of that program on `PATH`.
- A test file stays within about 300 lines, split by topic
  (`<name>.<topic>.test.ts`), so one commit can carry a change and its test.

## Accounts and state

- **One label is one logged-in session.** The tools join a Telegram account
  through [mtcute](https://mtcute.dev) with an `api_id` and `api_hash` the
  user obtains at [my.telegram.org](https://my.telegram.org); they never read
  another client's data. Logging in is a person's step, and it names the label
  the session is known by.
- **A label is 1 to 24 lowercase letters, digits and `_`**, starting and
  ending with a letter or a digit; logging in names it `default` when no label
  is given. A label is also a directory name, so the set is kept to what every
  file system takes as it is.
- **Each label keeps all of its state in one directory**,
  `<state root>/<label>/`, created with mode 700: the session and the app's
  `api_id` and `api_hash`, mtcute's storage, the mirror, the service's socket,
  short-lived copies of files in transit (`incoming/`, `outbox/`), and the
  files `keep_disappearing` kept (`kept/`). The state root is the `state_dir`
  setting, by default `$XDG_STATE_HOME/telegram-tools`, or
  `~/.local/state/telegram-tools` without it. One directory per label means a
  label is moved, backed up or removed as a whole, and nothing of one account
  sits in another's.
- **`account` picks the label.** Left out, it picks the only logged-in label;
  with several, the call fails as `invalid_argument` and lists them. One
  account is the common case and needs no argument, while several never
  depend on which one a tool guesses.
- **A label reaches only its own account.** A chat id is looked up only in
  that label's mirror, and a call to Telegram goes only through that label's
  service, so no argument can carry a call to an account the label does not
  name.
- **The session and credentials never leave the state directory.** Nothing
  from the session or the app's credentials reaches a result, an error or a
  log, and no tool reads or writes the state directory except through the
  mirror, the service client, the outbox, the folder the service downloaded
  into under `incoming/`, and the files under `kept/`. The session stands for the
  account itself: whoever holds it reads and sends as the user, on every
  device.

## The service client

- **Every call to Telegram goes through one client**, as every program goes
  through one runner: JSON-RPC 2.0 on the label's UNIX socket, one request
  per line, a time limit with cancellation, the service's errors mapped to the
  error codes above, and nothing but the label's own socket reached. A tool
  never opens the socket itself and never connects to Telegram.

## The sync service

- **The sync service holds the label's only connection to Telegram**, on
  mtcute, behind one module: it receives updates, writes the mirror and
  answers the tools' requests. An auth key used from two places at once can
  be revoked by Telegram, so a second connection can end the session.
- **Update handlers are in place before connecting**, so the catch-up replays
  edits and deletes that happened while offline before new updates arrive. A
  mirror that cannot be written stops the service at once, so the update
  state never moves past an update the mirror did not store.
- **A missing or revoked session stops the service.** With no session, or
  once Telegram has ended it, the service exits and stays down until the label
  logs in again, rather than restarting against an account it can no longer
  reach.
- **The service is a quiet client.** It sends no read marks, online status or
  typing indicators of its own, so the phone keeps its notifications and
  nobody learns that a message was read by a tool. The API terms §1.4 forbid
  tampering with read and online statuses; the service changes nothing the
  user's own devices show, and marks nothing read unless a tool is called to.
- **Background reads are paced and flood waits are honored.** A flood wait is
  never retried through, since retrying lengthens the wait.

## The mirror

- **What the mirror keeps depends on the kind of chat.** Private chats, bots,
  basic groups and Saved Messages are mirrored always; supergroups while on
  the sync list; channels while on it with the `channels` setting on; forum
  topics as topics.
- **The sync list names the supergroups and channels the mirror keeps**, at
  most 30. They are the chats a user chooses: a busy supergroup or channel
  would fill the mirror and the model's reads with text nobody asked for, so
  none is kept until it is added. The list lives in the mirror, and the
  service is its only writer, as of everything else there: adding and removing
  are requests to the service, which applies the list again at every start. A
  chat added is seeded with its newest messages, as a new chat is, and kept
  current after; a chat removed loses its mirrored messages and earlier
  versions and can still be read live, because the mirror holds only what it
  keeps current. A history fetch checks the list when it writes, so a chat
  removed during one stores nothing.
- **With `channels` off no channel is anywhere.** The service lists none,
  reads none, keeps none and takes none onto the sync list, and at start it
  deletes every channel the mirror has, with its messages, earlier versions,
  topics and place on the sync list. Turning the setting on again lists them
  again; the ones to keep are added again.
- **A chat is Telegram's signed chat id as a string**, such as `"123456789"`
  for a user or a bot, `"-4567"` for a basic group, or `"-1001234567890"` for
  a supergroup or channel. Chat ids are strings because a supergroup id has
  13 digits and a sign, and a string is never rounded. A forum topic is an
  argument of its own. Names, usernames and phone numbers are never accepted
  as a chat: anyone can choose a name, and a username can change hands.
- **A message is its chat plus its id within that chat**, since Telegram
  numbers messages per chat.
- **History starts where the service started following a chat.** Older
  history comes only from a history fetch, and the skills say so.
- **A chat the mirror does not keep is read live, and only it.** The read is
  a request to the service for at most 100 messages, stored nowhere. A chat
  the mirror keeps is always read from the mirror, which is current while the
  service runs, so the same question never costs a request to Telegram.
- **A history fetch is a read.** It asks the service for older pages of a
  chat the mirror keeps, 100 messages each, 1 by default and at most 5, paced
  0.5 to 1.5 seconds apart, and the service stores them as it stores what it
  receives. Nothing changes at Telegram and nothing is added that Telegram
  does not show the user, so it needs no approval; the page limit and the
  pacing keep it from reading a whole chat at once.
- **The mirror keeps what Telegram shows the user.** Messages they receive,
  messages they send from other devices, and the tools' own sends as they
  come back from Telegram; an edit keeps every earlier
  version. Delete for everyone removes the message, its files and its earlier
  versions, with a short-lived tombstone so a fetch in flight does not bring
  it back.
- **Disappearing and view-once messages leave when they expire.** They leave
  the mirror with their files by default, as their sender meant and the API
  terms §1.4 require. With `keep_disappearing` on they are kept and marked with
  a note in a field of its own that they are for the user only, with their
  files kept as they arrive.
- **Channels never bring sponsored messages.** None is fetched or shown:
  advertisements are text nobody in the chat chose, and keeping them out
  avoids untrusted prompts reaching the model. They come only from a request
  of their own, which nothing sends; history, search and updates never carry
  them.
- **Every read opens the mirror read-only and needs no service**, so reading
  works while the service is down and can never change what was received.
  Reads of chats the mirror does not keep are requests to the service and
  store nothing. Read-only means every write refused (`query_only`), never
  migrating, and never creating the mirror; the connection itself is SQLite's
  ordinary one, since a read-only connection cannot open a WAL database once
  its `-shm` file is gone, and a WAL reader takes part in the shared-memory
  locking that lets it read while the service writes.
- **Other people's words are data.** Message text, names, captions and file
  names are written by other people; every read tool's description and the
  skills say so, and nothing a message says is followed as an instruction.

## Files

- **Files go in and out only through the directories a setting names**,
  judged by real path, so a link that leads elsewhere counts as elsewhere.
  The state directory and the tools' own install directory are never among
  them, nor inside them.
- **Received files are saved under `download_dir`**, by default
  `~/Downloads/telegram-tools`, where a person looks for what they downloaded.
  A message's file goes in `<download_dir>/<label>/<chat id>/<message id>/`,
  directories mode 700 and files mode 600, never executable: a received file
  is private, and someone else wrote it. A file already there is never
  overwritten: the same file is reused, another one gets a numbered name.
- **One call saves one message's file.** A Telegram message carries at most
  one file, and each file of an album is a message of its own.
- **The service downloads, and only into the label's `incoming/`.** The
  mirror keeps facts about a file, never Telegram's file id or reference, so
  the service takes the message again and downloads it into a fresh folder
  there; the tool takes only a file inside that folder and removes the folder
  after the call. No name a message carries reaches the file system before it
  is cleaned: the sender chose it.
- **A download stops at `download_max_mb`**, 100 by default and at most 2000.
  A file declaring more is refused before anything is downloaded, and a
  download that passes the limit stops and leaves nothing. Telegram takes
  files of several gigabytes, and the one connection serves every request.
- **Programs and installers are never saved**, judged by the name, the
  declared type and the first bytes, since any one of them can lie. Source
  code is saved as text: it runs only if someone runs it. Animated stickers
  (`.tgs`, gzipped Lottie) are refused like an archive nothing can inspect.
- **An archive is saved only once its contents pass inspection**, on the
  downloaded copy itself: a zip, tar or gzipped tar holding no program,
  installer, nested archive, link or special file, encrypted entry, or path
  that leaves it, within 500 entries and 500 MB unpacked, counted from the
  bytes read rather than from what the archive claims. Every other archive
  format is refused: what cannot be read cannot be checked. An app or system
  bundle inside it, or a name holding control or direction-changing
  characters, refuses it too. Its listing comes back with names cleaned of the
  remaining invisible characters, which could make one name read as another.
  The inspection lives in a module of its own that knows nothing of Telegram.
- **A document built on zip is a file, not an archive.** Word, Excel,
  PowerPoint, OpenDocument and EPUB files are saved whole and never unpacked,
  since they routinely hold other zips (a chart holds a spreadsheet). One
  with macros is refused like a program.
- **Unpacking is asked for, never automatic.** It goes into
  `<name>.unpacked/` beside the archive, from a private copy inspected again,
  following no link; a failure removes everything it wrote.
- **Disappearing and view-once files follow their messages.** A disappearing
  message's file is saved, while the message lasts, with the same note as its
  text. A view-once or self-destructing file is refused, since its sender
  meant it to be seen once, unless `keep_disappearing` kept it.
- **With `keep_disappearing` on, the service keeps their files as they
  arrive**, in the label's `kept/`, at most 100 MB each and never a program or
  an archive; a file that arrives while the service is down is not kept.
  Delete for everyone removes the kept file with its message. Saving such a
  message saves from that copy, through the same checks.
- **On macOS every saved and unpacked file carries the quarantine flag**, set
  through the runner, so the system checks it before anything opens it as an
  app; elsewhere nothing stands for it.

## Writes

- **A write's arguments are the whole change**: the chat by id, the text as
  it should arrive (surrounding blank space trimmed), the files by path.
  Nothing is chosen at run time from the current state. The harness shows the
  arguments when it asks, so what it shows is what goes out.
- **A send is one call with one `random_id`**, never repeated by the package.
  A repeat of the same call with the same id is `RANDOM_ID_DUPLICATE`, never a
  second message, whereas a new id would be.
- **A send's outcome is never guessed.** A result means Telegram accepted the
  message. A failure known to happen before anything left throws its code.
  Everything else throws `uncertain`: the message may have gone out, the mirror
  cannot tell, and it is checked in the chat before any second send. A resend
  that guessed wrong reaches the other person twice.

## Toolsets

- **One per domain**: `account`, `chats`, `sync` (which supergroups and
  channels the mirror keeps), `files`, `sends`, and `actions` for what the
  user does to messages beyond sending them.
- **`account`, `chats`, `sync` and `sends` are on by default.** They cover
  reading a chat, choosing what the mirror keeps, and answering it without
  needing anything turned on. Saving received files writes to disk and opens
  archives, and the actions change what others have already read, so each is
  one setting away.
- **`keep_disappearing` and `channels` are off by default.** They are taken
  like `state_dir` (a flag, a `TELEGRAM_TOOLS_*` environment variable, or a
  plugin option). Keeping disappearing messages goes against API terms §1.4.
  For channels, API terms §3.3 asks an app showing channel content to show
  sponsored messages, which are text from advertisers nobody in the chat
  chose, a new way for instructions to reach the model; whoever turns
  channels on accepts that §3.3 risk.
- **`download_dir` and `download_max_mb` are taken the same way** and read by
  the save tool, which sends the limit with each download, so changing either
  needs no service restart; the service refuses a limit over 2000.

## Unofficial

- **The package is unofficial.** The README and the device name the service
  logs in as say the package is unofficial, as the API terms §2.2 and §2.3
  require. Each user registers their own app at
  [my.telegram.org](https://my.telegram.org) (§2.1).
