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
- **The MCP server takes the call's directory from the client.** It uses a
  directory sent with the call (Codex), else the client's first usable root,
  else the process's working directory; never inside the install directory.
  This keeps a server started in its install directory out of the working tree.

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
- **It shows what the call carries, where the tool can say.** Targets are
  ids, so they cannot tell one kind of target from another, and the person
  decides on the text, the file or the kind of target as much as on where it
  goes. A write tool's `describe` says it. An MCP client draws the call's
  arguments in its own prompt, so the MCP server adds nothing.
- **Every native plugin's prompt has one shape**, so a person reads every
  tool's prompt the same way:

  ```text
  About to create "todo.md"

  --- Details ---

  Target: /work/tree/notes/todo.md
  Size: 42 bytes

  --- Note text ---

  # Todo
  ```

  The headline says what the agent is about to do, as its next step; the
  Details name each target on a `Target` line, then the tool's facts; the
  last section is the text the call carries, under the tool's own label. A
  section with nothing to show is left out, so a tool without `describe`
  shows its intent and its targets, and one whose targets cannot be told
  shows its intent alone. The harness names the tool beside the prompt, so
  the prompt does not repeat its id.

- **A write tool states its intent.** Besides its title, which names the
  tool wherever tools are listed, a write tool gives an `intent`: a fixed
  phrase in the headline's tone that carries no value (`About to create a
note`). The prompt shows it wherever no headline can stand: a tool without
  `describe`, a headline that is dropped, and one that gives way to keep the
  targets within the budget. A tool without an intent shows its title there.

- **The tool's words are fixed; what the call carries is data.** A model
  chooses the arguments and nothing else, and a prompt is only as good as the
  person's trust in its lines. The headline is the tool's intent, or a
  template the tool picks (`About to create {file}`) whose values the entry
  point quotes, so where the tool's words end and the call's data begins is
  always visible. A value comes from what the tool resolved, never from a
  model's account of it (the record's real name, not the name the model
  gave). The text section holds what the call writes, as it is, never a
  summary of it; a summary the tool can compute is a fact (`Size`, `Lines`).
- **Facts are short and ordered by what they decide.** A label is a noun of
  one or two words, in English like the tool's title, and a value carries
  its unit (`42 bytes`). A value with a unit or other words of the tool's is
  a template the tool picks with the values it holds (`{bytes} bytes` with
  `bytes: 42`), so the unit is the tool's word and the number the call's
  data; the tool picks the English form for the count (`{bytes} byte` for
  one), and numbers are shown as written, without digit grouping. A plain
  string value has no words of the tool's. The fact that changes the person's answer comes
  first (the kind of target, whether it overwrites); amounts come last. A
  fact never repeats the headline or a target. `src/core/facts.ts` holds the
  facts every package can use (`sizeFact`); a package adds its own beside its
  tools in the same form and lists them in its section below.
- **The head of the prompt comes first and fits; the text comes last.** Some
  harnesses cut a prompt from its end at a few hundred characters, so the
  headline, the targets and the facts are kept within the budget of where the
  prompt is shown, and the text is what is cut. A headline that would push a
  target past the cut gives way to the intent, since the targets are what an
  "always" answer stores. Facts that do not fit are counted on a notice
  line, which stays even when the head alone fills the budget: a person
  must know that something was left out. The facts a description drops past
  its eighth are counted on the same line, `(+N more)` after the facts, in
  every prompt, budget or none. A description keeps a
  headline template of 120 characters with values of 80, its first eight
  facts with labels of 40 characters and values of 200 (a value template of
  200 with at most eight values, the filled value cut to 200), and a text label of
  40 with a text of 2000; anything longer is cut with `…`. Nothing in the text
  can come before the facts, since the text is the last section.
- **A cut text says how much it leaves out.** A `…` also ends many ordinary
  messages, so it alone cannot tell a person that the text goes on, or how
  far. A text cut at its 2000 characters is followed by a notice line,
  `(+N more characters)`, and a fact's value cut at its 200 by the same
  notice after it on its line, where the line still fits the budget; a value
  the budget cuts further ends in `…` alone, since what it drops is no longer
  counted in the tool's characters. N counts the code points left out of what
  the tool gave, the unit the cut counts (`(+1 more character)` for one), and
  the notice is the plugin's own words, translated like the facts' notice.
  Only the head counts towards the budget, so the text's notice is lost
  wherever the harness cuts the text, which then shows its own end mark.
- **Characters other people wrote are shown, never obeyed.** A target's name
  or a file's name can hold control, bidi and invisible characters that
  forge a line of the prompt or hide part of a value; each is shown as
  `<U+XXXX>`, and a quote inside a headline value as `\"`. Where the prompt
  renders markup, everything but the plugin's own section lines is escaped,
  so a name cannot draw a link or a mention. The budget and the escaping are
  those of the surface the harness names. A surface the harness shows as
  written, such as its own clients, gets neither. A surface it names that the
  plugin does not know is one the harness does not cut, so it gets no budget,
  but it may render markup the plugin cannot tell, so it gets the strictest
  escaping of all: an escape shown as written reads as a stray backslash,
  while a name left unescaped can draw a link or a mention. A prompt whose
  surface cannot be told gets the strictest budget and escaping of all.
- **A description never stands between a call and its approval.** A tool
  without `describe`, a `describe` that fails, returns another shape or takes
  longer than 10 s gives the prompt it would have given without one. The
  approval is asked either way, and the targets are never lost with the
  description.
- **A call no answer may let run is refused before anyone is asked.** Some
  calls are out of reach whatever the person would say, such as one naming
  an object the settings keep away from the agent; a prompt for it would
  show what it names and invite an "allow" that cannot be honored. A tool
  that can tell such a call from its arguments and settings gives a `gate`
  (see "The core contract"). Every entry point runs it before the approval
  and again before `execute`, so a refusal is the call's result, as an
  error, and no prompt is drawn: a native plugin asks nothing, and the
  Hermes plugin blocks the call. Unlike `targets` and `describe`, a gate
  fails closed: one that cannot tell fails the call with `internal_error`.
  Where the question itself cannot be resolved (the Hermes plugin's `target`
  fails or times out), the person is asked as before, and the run refuses
  the call after the answer. An MCP client draws its own prompt before the server sees the call, so
  there the refusal comes after the client's question, never after the run.
- **A call runs on what its prompt showed.** What a person approves is what
  was true when the prompt was drawn; between the answer and the run, a file
  the call reads can be rewritten or a target can change kind. So a native
  plugin pins the prompt of every call whose tool has `describe`: the
  targets and the description, before translation, as one hash. The hash
  takes the description whole, before the budgets above cut it: a text past
  its 2000 characters, a value past its cut and the facts past the eighth
  are what the call carries too, so a change there is a change of the call
  even where the prompt could not show it. Right
  before the call runs, the entry point resolves both again, and a call
  whose hash differs, or whose description can no longer be told, fails with
  `stale` without running; the person is asked again on the next call. A
  call whose prompt showed no description pins nothing and runs as before,
  and so does every call of a tool without `describe`. A `describe` may also
  give `pins`, values the prompt does not show that the call must still find
  unchanged (a file's hash, beside a size that can stay the same); they go
  into the hash and nowhere else. A `describe` therefore gives the same
  answer for the same state: a value that changes on every call, such as the
  time, makes every call `stale`. The check narrows the gap between the
  answer and the run to the moment before `execute`; a tool that must close
  it entirely still checks inside `execute`. An MCP client draws the call's
  arguments, not a description, so the MCP server pins nothing.
- **The prompt speaks the language set for the harness.** A native plugin
  draws its prompt in the language of the `language` setting, else in the
  harness's own display language where it has one (Hermes's
  `display.language`), else in English. No harness tells a plugin who
  approves a call, so this is the language set where the plugin runs, not
  each person's. The server's locale (`LANG`) is never read: it is the
  machine's, and a person reading English on a machine set to another
  language would see the prompt change. A tag matches its own table, else
  the one of its first subtag (`ja-JP` and `ja_JP` are `ja`; `zh-Hant` can
  have its own), and a language the package has no words for falls back to
  English without a word. An MCP client draws its own prompt,
  so the MCP server takes no `language`.
- **Translations are tables keyed by the English words.** The plugin's own
  words (`Details`, `Target`, `(+N more)`) and a tool's (its title, its
  intent, its headline templates, its fact labels, its value templates and its text
  label) are written in
  English in the code. Per language, a package gives one table from those
  English words to their translation (`src/words.ts`), and the entry point
  looks each word up as it draws the prompt, so a tool's code does not change.
  A translated template must hold the same placeholders as the English one
  and keep within its limits, or the English one is used, so a translation
  cannot move the line between the tool's words and the call's data. Values
  are the call's data and are never translated: a value template is looked
  up and its values filled in after (`{bytes} バイト`), and a plain string
  value stays as the tool wrote it. A translation is marked like every other
  piece of the prompt.
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
- **`state_dir`** is this package's `path` option for every account's state
  (see "Accounts and state"), read as "Options" below describes.
- **`download_dir`**, **`download_max_mb`** and **`send_dirs`** are this
  package's options for files (see "Files"), read as "Options" below describes:
  a `path`, a whole `number` from 1 to 2000 (MB), and `paths`, respectively.
- **`keep_disappearing`** and **`channels`** are this package's `boolean`
  options, both off by default (see "The mirror"), read as "Options" below
  describes, but only by `sync` and `service`. Run `service install` again
  after changing them.
- **`exclude_chats`** is this package's `list` option of chat ids that every
  tool leaves out (see "Excluded chats"), read as "Options" below describes.
  The tools read it and the service does not, so two harnesses sharing one
  account can each set their own.
- **`language`** is the language of a native plugin's approval prompt (see
  "Write classes"); unset, the prompt follows the harness's display language
  or stays in English.
- **`emoji`** maps a toolset name to the emoji the Hermes plugin shows beside
  it, merged over the package's `TOOLSET_EMOJI`; `""` shows no emoji for that
  toolset, and no other entry point shows an emoji. A value that is not a
  mapping, an entry whose value is not a string, and a name that is no toolset
  are ignored rather than refused: the setting only changes what is shown, so a
  typo must not take every tool away.
- **`require_plugins`** names the Hermes plugins the Hermes plugin's writes
  depend on, such as a guard whose `pre_tool_call` block keeps writes from
  running unattended. Hermes drops a plugin that fails to import or register
  and loads the rest, and treats a manifest's `requires_plugins` as advisory,
  so a guard can vanish with nothing to say so. While any named plugin is not
  loaded (`ctx.has_plugin` says no, or cannot be asked), every call of a tool
  that is not a read is refused before its approval is asked, so neither YOLO,
  an approvals mode of `off` nor a remembered answer lets it run, and again
  before it runs. The refusal is `forbidden` with `details.reason`
  `missing_plugin` and `details.plugins` the names missing. Reads run as
  before. The check runs on every call, not at registration, since the order
  in which Hermes loads two plugins is not the plugins' to fix. Unset or
  empty, nothing is checked. A value that is not a list of names is refused,
  like a wrong `read_only`, and the plugin then registers nothing: ignoring it
  would loosen what the person asked for. No other entry point has it.
- **Options** are the package's own settings, the ones the tools themselves
  read, listed in `options` in `src/project.ts` (and `OPTIONS` in the Hermes
  plugin's `project.py`), each mapping a snake_case name to its type (`text`,
  `boolean`, `number`, `list`, `path` or `paths`) or a declaration with
  `{ type, integer, min, max }`. `integer: true` requires a whole `number`;
  `min` and `max` bound a `number` or count the items of a `list` or `paths`.
  Only `type` is required. Its flag is the name with `_` as `-` (a
  `boolean` flag takes no value), its variable is `<envPrefix>_<NAME>`
  uppercased, and its plugin option or setting is the name itself. A flag wins
  over its variable, an option over its variable, and a blank text or path or
  empty list counts as unset. A `path` is trimmed; `~` alone or followed by
  `/` (or the platform separator) stands for the home directory: `HOME` when
  it is absolute, else the account's.
  The expanded path must be absolute and reaches the tool normalized, without
  a filesystem check. A `paths` value is a list of such paths, comma-separated
  in a flag or variable and an array of strings in a plugin option; items are
  trimmed and blank items dropped, and none left counts as unset. Bounds
  check only a value that is given, after blanks are dropped; unset stays
  unset. Refused values are `invalid_argument`, naming the flag, variable or
  option and what it must be. A package should not have to check a directory
  or a limit again inside its tool. They reach a tool as `context.options`,
  keyed by name, and one that is not given is absent: a neutral default means
  unset, and the tool then does nothing extra. A tool reads an option when it
  runs, so a change applies on the next call.
- **`unattended`** says that no person can answer a question, as in a
  scheduled job, CI or a headless run; **`grants_dir`** is the `path` where
  grants and their use are kept. See "Writes no one is there to approve".

## Writes no one is there to approve

When no person can answer, a harness either refuses a write or, with its
approvals skipped, runs it with no limit at all; a host's allow rule names a
tool and at most its targets, with no expiry, no count and nothing about what
the call carries. So a person delegates, in advance, a bounded set of writes,
and every entry point checks them the same way.

- **The person decides what to delegate; the package keeps only its
  guarantees.** A person who cannot delegate a write still runs it
  unattended through the host, with no bound and no record, so a rule that
  narrows what can be delegated protects nothing and only pushes the person
  there. The package limits a grant only where the mechanism needs it: the
  expiry ceiling, that only a person's answer creates a grant, and the
  signatures, the log and the lock. Everything else (which tool, which
  targets, which bounds, how many calls) is the person's choice, shown whole
  on the consent screen.

- **A setting says that no one can be asked.** No harness tells a plugin or
  an MCP server that its questions will go unanswered, and the modes that
  skip approvals are the ones with no person in the loop, so nothing is
  inferred from them. `unattended` says it. Off, the default, nothing changes
  and grants are not read. On, a read runs as before and a write runs only
  under a live grant that covers it.
- **Every write tool can be granted; a tool may add what a grant can
  bound.** A grant over any write tool limits its targets, its rate and its
  expiry. `bounds` adds more, naming each bound with its kind: `max` (a whole
  number the call must stay at or under, such as a text's length in
  characters), `allow` (whether the call may do one thing, such as attach a
  file) or `oneOf` (the values the call may use, such as DNS record types).
  `measure(args, context)` gives the call's value for each: a number, a
  boolean, or one or more of the declared values. A tool declares at most six
  bounds and a grant's values must fit a fact (200 characters), so the consent
  screen shows every one. A bound is a fact about the call, computed the same
  way every time, never the model's account of it, and it is checked whole,
  never cut to a budget as a prompt's facts are.
- **A grant** names one tool, its targets, a value for the bounds the person
  limits, a rate in calls per hour or none, and an expiry of at most 90 days.
  Its targets are names, or `*` alone for any target, the call's included when
  it cannot be told; a pattern beside or inside a name is refused. A call is
  covered when its tool matches, every target it resolves is among the
  grant's (or the grant's is `*`), every bound the grant sets is met by the
  measured value (at or under a `max`, `false` or allowed for an `allow`,
  every value among a `oneOf`'s), the grant has not expired, and, when it sets
  a rate, fewer calls than the rate ran under it in the last 60 minutes. A
  bound the grant leaves out is no limit, and the consent screen says so; a
  measure that fails or returns another shape covers nothing under a grant
  that sets a bound. Where several grants cover a call, one that names its
  targets is used before a `*` one, then the one with the fewest targets,
  then the one that sets the most bounds, then the one that expires first.
  A call counts against its grant's rate whether it succeeds or fails, and
  every call is logged whether the grant sets a rate or not.
- **Grants restrict; the host still allows.** `invoke` checks the grant
  after the gate and before `execute`, so the MCP server and the command
  line's `run` enforce it too, and the native plugins and the Hermes
  plugin's `target` check it before they ask, refusing without a question.
  The harness's own permission still decides whether the call reaches the
  package at all (an allow rule, an allowed-tools list, an approve mode), so
  a grant means the same in every harness and never lets a call through
  that the host would stop.
- **A refusal says why.** It is `forbidden`, with `details.reason`.
  `person_only` (a tool only a person's own answer may run), `no_key` and
  `tampered` (a grant or the log fails its MAC) refuse every call. Otherwise
  each grant that names the tool is checked in order, `expired`, `target` (a
  target outside the grant, or one that cannot be told, under a grant that
  names its targets), `bound` (named in
  `details.bound`) and `rate`, and the reason is the one of the grant that
  passed the most checks; `no_grant` when none names the tool. The message
  says what a person would change: a new grant, or waiting for the rate.
- **A person delegates; the agent only asks.** `<prefix>_grant_create`
  takes the tool, the targets, the bounds, the rate, the days it lasts and a
  reason. It is administrative, and its prompt is the consent screen: the
  headline names the tool (and says it may write anywhere under `*`), the
  facts the rate (or no limit), the expiry and every bound the tool declares
  (`no limit` for one left out), named targets stand as targets (a prompt
  shows no target line for `*`, so the headline carries it) and the reason
  as text, and the pin makes the
  grant exactly what the prompt showed. Widening or extending one is a new
  grant. `<prefix>_grant_read` lists the grants and their use, and
  `<prefix>_grant_revoke` removes one. They form the `grants` toolset, off by
  default.
- **Only a person's answer creates a grant.** A grant that the agent could
  give itself would bound nothing. `grant_create` is marked person-only: it is
  refused while `unattended` is on, no grant ever covers a person-only tool
  nor can one be created for it, and every
  entry point keeps a standing answer from covering it: the OpenCode plugin
  makes its permission `ask` with nothing to save, the MCP server marks it
  `requiresUserInteraction` and asks through form elicitation where the
  client offers it, whatever `confirm` says, and the Hermes plugin gives each
  call a rule key of its own. A harness run with every approval skipped asks
  about nothing, and no package can tell; the README says so for each
  harness. Revoking only narrows, so `grant_revoke` runs while `unattended`
  is on without a grant.
- **Grants and their use are signed with a key the host supplies.** The
  variable `<envPrefix>_GRANT_KEY` (at least 32 characters; a variable only,
  never a flag or a plugin option, so it stays out of configuration files)
  keys an HMAC-SHA256 over each grant and over a chained log of every call
  made under one: the grant, the tool, the targets, the measured values, a
  digest of the arguments, when it started and how it ended. A grant or a
  log edited outside the package fails its MAC, and nothing runs under any
  grant until a person revokes the grant that fails (`grant_read` marks it)
  or, for the log, clears the directory. Without the
  key, while `unattended` is on, no write runs and no grant can be created.
  The files are written under a lock and replaced whole, since several
  processes may run calls at once. An earlier copy put back whole, MACs
  included, is not detected; the expiry bounds what it can bring back.

## Skills

- **A skill names the toolset it documents**, under `metadata` in its
  frontmatter:

  ```yaml
  metadata:
    toolset: sends
  ```

  The Agent Skills format allows no other top-level key, and its validators
  refuse one. The value is a plain or quoted one-line scalar; any other form
  reads as no link. A folder's name never links a skill, so every entry point
  reads the link the same way without knowing the package's toolsets.

- **A native plugin registers a linked skill only when its toolset is on**:
  when the settings register at least one tool of that toolset, from the same
  selection the tools come from. A skill that describes tools the model does
  not have invites calls that fail. So `read_only`, `tools` and
  `exclude_tools` count too: a toolset whose every tool is left out takes its
  skill with it. A skill with no link is always registered.
- **Plugins that install the skill folder whole cannot follow the settings**:
  Claude Code, Codex, Grok Build and Antigravity load every skill, since the
  settings reach only the MCP server.
- **Every linked skill names one of the package's toolsets**; a test checks
  it, since a misspelt link would hide the skill wherever it is filtered.
- **A skill that works across toolsets names the one it cannot work without.**
  The link holds one toolset, and a skill linked to none would be registered
  with every tool it describes turned off. Its body says which steps to skip
  when another toolset's tools are missing, and it leans only on toolsets that
  are on by default, since the plugins that install the skill folder whole
  list it whatever the settings select.

## The core contract

- A tool spec declares its ID, description, argument schema, output schema,
  toolset and write class; every entry point derives the same metadata from
  it. A write tool also declares `targets(args, context)`, which names what
  the call writes to.
- Any tool, read or write, may declare `gate(args, context)`, which throws a
  `ToolError` (usually `not_found`, worded as for an object that does not
  exist) for a call no approval may let run, and returns otherwise. `invoke`
  runs it after the arguments are checked and before `execute`; the entry
  points also run it before they ask (see "Write classes"). It is cheap, it
  reads only what it needs to decide, and its message says no more about
  the target than the arguments already do.
- A write tool may declare `bounds` and `measure(args, context)`, which say
  what a grant over it can limit beyond its targets, rate and expiry, and
  what this call's values are (see "Writes
  no one is there to approve"). `defineTool` refuses a `measure` without
  `bounds`, a bound of an unknown kind, a `oneOf` with no values and more than
  six bounds.
- `execute(args, context)` gets the working directory, an abort signal, an
  optional `ownDir` (the directory the tools are installed in, never the
  working tree), the values of the package's own settings as `options` (see
  "Toolsets and settings"; `gate`, `describe` and `targets` get them too) and
  an optional `confirm(request) => Promise<boolean>` hook.
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
  file system takes as it is. `grants` is reserved: the grants directory
  defaults to `grants` under `$XDG_STATE_HOME/telegram-tools`, where the
  labels' directories sit by default, so no label may take that name, and
  listing the labels skips it.
- **Each label keeps all of its state in one directory**,
  `<state root>/<label>/`, created with mode 700: the session and the app's
  `api_id` and `api_hash`, mtcute's storage, the mirror, the service's socket,
  the service record, short-lived copies of files in transit (`incoming/`,
  `outbox/`), and the files `keep_disappearing` kept (`kept/`). The state root
  is the `state_dir` path option, by default `$XDG_STATE_HOME/telegram-tools`
  when `XDG_STATE_HOME` is absolute, else `~/.local/state/telegram-tools`.
  One directory per label means a label is moved, backed up or removed as a
  whole, and nothing of one account sits in another's.
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
  mirror, the service client, the outbox, the service record, and the folder
  the service downloaded into under `incoming/`. The session stands for the
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
- **The service record names what the service starts.** Installing the
  service writes `<label>/service.json`, mode 600: the program and the script
  it runs, as paths, and nothing else; uninstalling deletes it. The account
  read checks that both still exist, since a program removed by an update
  stops the service only at its next start, and the system's own log names
  just the missing file. A stopped service is then told to be installed again,
  and a running one is told before it stops, rather than after receiving has
  ended.
- **Installing prefers a program at a path that outlives updates.** A
  program whose path holds its own version goes when that version is
  removed, so installing looks on the recorded `PATH` for one at a path
  without it that starts the same program, and says so when there is none.
  One under the temporary or runtime directory is passed over, since it is
  gone after a restart. The program is the same at install only: a link or
  a shim follows whatever its owner makes current later, which is the point
  of choosing it.
- **The service is a quiet client.** It sends no read marks, online status or
  typing indicators of its own, so the phone keeps its notifications and
  nobody learns that a message was read by a tool. The API terms §1.4 forbid
  tampering with read and online statuses; the service changes nothing the
  user's own devices show, and marks nothing read on its own. Reading through
  the tools never marks a message read; only the mark-read tool does, up to
  the message the user names.
- **Background reads are paced and flood waits are honored.** A flood wait is
  never retried through, since retrying lengthens the wait.

## The mirror

- **What the mirror keeps depends on the kind of chat.** Private chats, bots,
  basic groups and Saved Messages are mirrored always; supergroups while on
  the sync list; channels while on it with the `channels` boolean option on;
  forum topics as topics.
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
  terms §1.4 require. With the `keep_disappearing` boolean option on they are
  kept and marked with a note in a field of its own that they are for the user
  only, with their files kept as they arrive.
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

## Excluded chats

A person who lets an agent use the account may want some chats kept from it:
a chat with a doctor or a lawyer, a family group. The tool lists and
`read_only` narrow what an agent can do, not where; `exclude_chats` narrows
where, per harness, so a chat open to one agent can stay closed to another
that shares the account.

- **An excluded chat is out of every tool, never out of the mirror.** The
  service keeps mirroring it as before, since the setting belongs to the
  harness that reads it and another harness may still read the chat; taking
  it off the list brings it back with its history. Only the tools leave it
  out.
- **A call that names one is refused before anyone is asked.** Every tool
  whose arguments name a chat refuses an excluded one through its `gate`, as
  `not_found` in the words the tool gives for a chat it does not know, so the
  refusal says nothing an unknown id would not. A sync change refuses the
  whole call when any of its chats is excluded.
- **A read leaves it out of what it returns.** `list`, a search across chats
  and the sync list leave excluded chats out before they count or page, so a
  page is never short of what it would be without them, and a cursor taken
  under one setting is refused under another. The account's counts of chats
  and messages leave them out too. The sync list's `size` still counts every
  entry, since the 30-chat limit is the service's.
- **A read never fetches anything of it for another chat.** A message in an
  allowed chat that replies to, forwards from or was sent by an excluded chat
  keeps the ids it carries, but the read adds neither that chat's name nor
  the text of the message replied to. What the message carries itself, such
  as the quote its sender chose or the name its forward header holds, is part
  of the allowed chat and stays.
- **A malformed setting stops the tools that read chats.** An entry that is
  not a chat id fails those tools with `invalid_argument` naming the setting,
  never its value, rather than leaving a chat open by mistake.
- **The setting is per harness, so it is set where the harness reads it**:
  its plugin option or setting, not the shared environment variable, when
  only one harness should leave the chat out. An MCP client draws its own
  approval before the server sees a call, so there a call naming an excluded
  chat can still be asked about by its id, then is refused.

## Files

- **Files go in and out only through the directories a setting names**,
  judged by real path, so a link that leads elsewhere counts as elsewhere.
  The state directory and the tools' own install directory are never among
  them, nor inside them.
- **Received files are saved under the `download_dir` path option**, by default
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
- **A download stops at the `download_max_mb` number option**, in MB: a whole
  number from 1 to 2000, default 100.
  A file declaring more is refused before anything is downloaded, and a
  download that passes the limit stops and leaves nothing. Telegram takes
  files of several gigabytes, and the one connection serves every request.
  A download that receives nothing for 60 seconds stops too: mtcute waits out
  flood waits and retries failed parts inside a download without end, so the
  stall limit is what bounds a flood wait there.
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
  an archive, judged again on its bytes once it is in. A file is kept when the
  service receives its message, live or in the catch-up after a restart; one
  Telegram has already removed by then is not kept. A kept file lasts as long as its
  message's row: delete for everyone removes it at once, and the service
  removes, at every start, any kept file whose message the mirror no longer
  has. Saving such a message saves from that copy, even once the message has
  expired at Telegram: the service copies it into a fresh folder under
  `incoming/`, so the save tool reads `incoming/` only and the same checks
  apply.
- **On macOS every saved and unpacked file carries the quarantine flag**, set
  through the runner, so the system checks it before anything opens it as an
  app; elsewhere nothing stands for it.
- **A file is sent only from the working directory or `send_dirs`.** The
  working directory is where the user pointed the agent, so "send this log"
  needs no setting; it does not count when it is the home directory or a file
  system root, which would open everything the user owns. The `send_dirs`
  paths option names the others, none by default; blank items are dropped.
- **Keys, secrets and programs never leave.** A file is refused for a key or
  settings folder anywhere in its real path (`.ssh`, `.gnupg`, `.aws`,
  `.config`, `.git`, …), a name that looks like a key or a secret (`.env`,
  `id_rsa`, `*.pem`, `*secret*`, …), a place under home that holds logins or
  backups, a private key block anywhere in it, or being a program or an
  installer; an empty file, a file with more than one name and the same file
  twice are refused too. Source code is sent when its bytes are text. A name
  is a weak sign, so it never stands alone: the bytes are read as well. The
  rules are the ones signal-tools applies, so both packages refuse the same
  files.
- **An archive is sent only once every entry passes the same rules**, read
  entry by entry with the inspection that checks received archives, never
  unpacked.
- **What is sent is the copy that was checked.** Each file is copied into the
  label's `outbox/`, private, hashed and checked there; the service uploads
  only files inside the call's folder there, and the tool removes the folder
  after the call, so a file that changes meanwhile never goes out unchecked. A
  `sha256` given with a file must match the copy, or the call is `stale`: an
  MCP client shows only a path when it asks. The approval prompt pins each
  file's hash, so a file changed after the prompt stops the call as `stale`
  before it runs.
- **A send carries at most 10 files and 100 MB together**, as one group in
  one call, so the call has one outcome; Telegram groups at most 10. Every file
  goes as a file, with its name, never compressed into a photo or a video:
  what arrives is the copy that was checked, and files of any kind can share
  a group.

## Writes

- **A write's arguments are the whole change**: the chat by id, the text as
  it should arrive (surrounding blank space trimmed), the files by path.
  Nothing is chosen at run time from the current state. The harness shows the
  arguments when it asks, so what it shows is what goes out.
- **A send is one call with one `random_id`**, never repeated by the package.
  A repeat of the same call with the same id is `RANDOM_ID_DUPLICATE`, never a
  second message, whereas a new id would be.
- **The sync service sends through mtcute's low-level call** with its retries
  and flood-wait sleeps turned off: its text sender cannot turn them off, and
  they would repeat the call after a server error or a short flood wait.
  mtcute still delivers a call again after a reconnect or a session reset,
  always with the same bytes, so with the same `random_id`.
- **A send's outcome is never guessed.** A result means Telegram accepted the
  message. A failure known to happen before anything left throws its code: the
  service not running, a chat refused before the call, Telegram refusing the
  chat, the reply or the text, a flood or slow-mode wait (`rate_limited`, with
  its seconds). Everything else throws `uncertain`: the message may have gone
  out, the mirror cannot tell, and it is checked in the chat before any second
  send. A resend that guessed wrong reaches the other person twice.
- **A refusal after a reconnect is `uncertain`.** When the connection was
  re-established while the call was out, an earlier delivery of it may have
  landed and the refusal may answer the repeat; without a reconnect the
  refusal stands.
- **`RANDOM_ID_DUPLICATE` is a send that went out.** It proves an earlier
  delivery of the same call landed, and no second message exists. The result
  gives the message's id when the mirror has it, and leaves it out otherwise.
- **A file send uploads every file first, then sends once.** An upload makes
  no message, so a failed or stalled upload throws its code with nothing
  sent; mtcute retries parts and waits out flood waits inside an upload, so an
  upload that moves no byte for 60 seconds stops, as a download does. The
  send that follows is one `messages.sendMedia` (one file) or
  `messages.sendMultiMedia` (several, a `random_id` each) under the rules
  above; a group is accepted only when Telegram names every file's message.
- **An `uncertain` send carries a hint**: the messages the user sent in that
  chat since the call began whose text is the same, or, for a file send, that
  carry a file of the same name and size, by id and time, as the mirror has
  them. It decides nothing; the error stays `uncertain`.
- **The service records its own send** in the mirror as Telegram returns it,
  since mtcute does not dispatch a client's own sends back as updates.
- **An action is one call too, with no `random_id`.** Editing, deleting,
  reacting, pinning and marking read go through the same low-level call, in
  the same queue as sends, with retries and flood sleeps off. None of them can
  be told apart from a repeat of itself, and mtcute may deliver a call again
  after a reconnect, so an answer saying the message is already as asked (an
  unchanged text, reaction or pin, a message already deleted) counts as done:
  the end state is the one the call asked for. A refusal without a reconnect
  is its code, with nothing changed; everything else is `uncertain`, checked
  in the chat before the action is asked again.
- **Edit and delete take only the user's own messages**, in a chat of the
  mirror. An edit replaces the text, or a caption, with the rules for a text
  above; one that changes nothing is refused before anything goes out, and
  Telegram's edit time limit decides how old a message may be. A delete is
  always for everyone (`revoke`; supergroups and channels have no other kind),
  since deleting only from the user's own devices would leave the message with
  everyone else; it is `administrative`, so it is asked every time, except in an unattended
  run under a grant that covers it.
- **A reaction is one standard emoji**, replacing the user's earlier one on
  that message, or removed. Custom-emoji reactions need Premium and paid ones
  spend Stars, so both are refused; which emoji a chat allows is Telegram's
  to decide.
- **A pin is silent and one-sided by default.** Pinning in a group tells the
  members only when the call asks to, and the prompt says so; in a private
  chat it pins for the user only unless the call asks for both sides, so the
  other person's screen changes only when the user meant it to.
- **Marking read goes up to the message the call names**, never further and
  never back: the model marks read what it read, and a message that arrived
  since stays unread. A topic is marked on its own.
- **The service records its actions in the mirror**, as it does its sends: an
  edit keeps the earlier version, a delete removes the message as a delete for
  everyone does, a reaction replaces the user's own, and a read moves the
  chat's read mark. Whether a message is pinned is not mirrored: mtcute
  reports no pin as an update, so the mirror could not keep it current.
- **A text is at most 4096 characters** after trimming, counted in UTF-16
  units as Telegram counts them, and goes out exactly as written, never parsed
  as Markdown or HTML: what the harness showed is what arrives. A caption is
  at most 1024, Telegram's limit for one without Premium.

## Approval facts

The facts this package's tools add beside the shared `Size`
(`src/core/facts.ts`), in the form "Write classes" describes:

- **`Chat`** is the kind of chat a call writes to, as a word of the tool's:
  `Person`, `Bot`, `Saved Messages`, `Group`, `Supergroup` or `Channel`. It
  comes first, since sending to a group or a channel is a different answer
  from sending to one person. Defined in `src/core/chat/facts.ts`.
- **`Topic`** is the forum topic, by its title in the mirror (else its id).
- **`Reply to`** is the message replied to, as `message {id}`.
- **`File`** is the kind of file a save downloads, as a word of the tool's
  (`Photo`, `Voice message`, `Link preview`, ...). The kind words, in
  `src/core/chat/media-facts.ts`, are shared with the actions' `Media` fact
  and cover every kind the mirror stores; a kind without one shows as the
  mirror names it.
- **`Unpack`** is `Yes` when the call asks to unpack an archive.
- **`Files`** is how many files a send carries, when it is more than one; the
  shared `Size` then is their total.
- **`Mirrored messages`** is `Deleted` on a call that takes chats off the sync
  list, since the mirror then deletes the messages it holds of them and their
  earlier versions; it comes first. It says no count: the count grows while the
  service syncs, and the pin of the prompt would then never hold.
- **`Chats`** is how many chats a call that names several changes; the headline
  then is the intent, since a count quoted as a headline value reads as a name.
- **`Message`** is the message an action changes, as `message {id}`, with
  **`Current`**, its text now as the mirror has it; an edit's prompt shows the
  new text as its text. **`Media`**, for a message with no text, is the kind of
  its media as one of the shared kind words, never under `Current`, so it is
  not read as the message's text.
- **`Replaces`** is the user's reaction a reaction call takes away.
- **`Notify`** is `Yes` when a pin tells the members, and **`Both sides`** is
  `Yes` when a pin in a private chat also pins for the other person.
- **`Up to`** is the message a mark-read call reaches, as `message {id}`. It
  says no count of what becomes read, since that grows while the service syncs.

A save pins when the message was last edited, since an edit can replace a file
and keep its name and size. A file send pins each file's hash by its real path,
since a file can change and keep its name and size. An action pins when the
message was last edited, and a reaction call the user's current reaction, so a
message that changed after the prompt stops the call as `stale`.

Values come from the label's mirror (the chat's own title, never the model's
account of it). A chat the mirror does not have gives no description, so the
prompt shows the intent and the target. An action on a chat without a name
keeps a headline without it, so what it does (a reaction's emoji, a pin or an
unpin) still shows. A call that names several chats, or one without a title,
lists them in its text under `Chat list`, one per line, by their title in the
mirror and their id.

## Toolsets

- **One per domain**: `account`, `chats`, `sync` (which supergroups and
  channels the mirror keeps), `files`, `sends`, and `actions` for what the
  user does to messages beyond sending them.
- **`account`, `chats`, `sync` and `sends` are on by default.** They cover
  reading a chat, choosing what the mirror keeps, and answering it without
  needing anything turned on. `files` saves received files, which writes to
  disk and opens archives, and sends the user's own, which takes them off the
  machine; the actions change what others have already read. So each is one
  setting away, and sending files has a tool of its own apart from texts, so
  a permission rule can let texts through and ask for every file.
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
- **`send_dirs` is taken the same way**, as a list of absolute paths, and
  read by the file send tool.

## Unofficial

- **The package is unofficial.** The README and the device name the service
  logs in as say the package is unofficial, as the API terms §2.2 and §2.3
  require. Each user registers their own app at
  [my.telegram.org](https://my.telegram.org) (§2.1).
