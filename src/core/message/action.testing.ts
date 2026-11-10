import type { z } from "zod"
import { outgoing, type ServiceCalls } from "../chat/read.testing"
import type { ToolError } from "../errors"
import { createSyncFixture, type SyncFixture } from "../sync/sync.testing"
import type { MessageInput } from "../telegram/mirror-input"
import { USER } from "../telegram/mirror.testing"
import type { deleteOutput, editOutput, pinOutput, reactOutput } from "./action-schema"
import { telegramMessageDelete } from "./delete"
import { telegramMessageEdit } from "./edit"
import { telegramMessagePin } from "./pin"
import { telegramMessageReact } from "./react"

/** The id of the user's own message that `own` stores in `USER`'s chat. */
export const OWN_ID = 7

/** The id of the other person's message that `theirs` stores in `USER`'s chat. */
export const THEIR_ID = 8

/** What an edit test serves when it asks for nothing else: Telegram accepted the edit. */
export const EDITED = { id: OWN_ID, edited: 1_800_000_000_000 }

/** What a delete test serves when it asks for nothing else: the message is gone. */
export const DELETED = { id: OWN_ID, deleted: true }

/** The emoji `react` asks for unless told otherwise. */
export const THUMBS_UP = "👍"

/** What a reaction test serves when it asks for nothing else: the reaction is `THUMBS_UP`. */
export const REACTED = { id: THEIR_ID, emoji: THUMBS_UP }

/** What a pin test serves when it asks for nothing else: the message is pinned. */
export const PINNED = { id: THEIR_ID, pinned: true }

/** A sync fixture and the ways to call the action tools in it, as an entry point would. */
export type ActionFixture = SyncFixture & {
  /** Follows `USER`'s chat (Alice Example) and stores the user's own message `OWN_ID` in it, "old text", each field overridden by `overrides`. */
  own(overrides?: Partial<MessageInput>): void
  /** Follows `USER`'s chat and stores Alice's message `THEIR_ID` in it, "from Alice", each field overridden by `overrides`. */
  theirs(overrides?: Partial<MessageInput>): void
  /** Calls `telegram_message_edit` for `OWN_ID` in `USER`'s chat with the text "new text", each argument overridden by `args`. */
  edit(args?: Record<string, unknown>): Promise<z.output<typeof editOutput>>
  /** The error an edit throws. */
  editFails(args?: Record<string, unknown>): Promise<ToolError>
  /** Serves the label's socket with an `edit` handler, which accepts the edit unless `answer` says otherwise; resolves with the requests it receives. */
  serveEdit(answer?: (params: unknown) => unknown): Promise<ServiceCalls>
  /** Calls `telegram_message_delete` for `OWN_ID` in `USER`'s chat, each argument overridden by `args`. */
  remove(args?: Record<string, unknown>): Promise<z.output<typeof deleteOutput>>
  /** The error a delete throws. */
  removeFails(args?: Record<string, unknown>): Promise<ToolError>
  /** Serves the label's socket with a `delete` handler, which deletes the message unless `answer` says otherwise. */
  serveDelete(answer?: (params: unknown) => unknown): Promise<ServiceCalls>
  /** Calls `telegram_message_react` for `THEIR_ID` in `USER`'s chat with `THUMBS_UP`, each argument overridden by `args`. */
  react(args?: Record<string, unknown>): Promise<z.output<typeof reactOutput>>
  /** The error a reaction throws. */
  reactFails(args?: Record<string, unknown>): Promise<ToolError>
  /** Serves the label's socket with a `react` handler, which sets the reaction unless `answer` says otherwise. */
  serveReact(answer?: (params: unknown) => unknown): Promise<ServiceCalls>
  /** Calls `telegram_message_pin` for `THEIR_ID` in `USER`'s chat, each argument overridden by `args`. */
  pin(args?: Record<string, unknown>): Promise<z.output<typeof pinOutput>>
  /** The error a pin throws. */
  pinFails(args?: Record<string, unknown>): Promise<ToolError>
  /** Serves the label's socket with a `pin` handler, which pins the message unless `answer` says otherwise. */
  servePin(answer?: (params: unknown) => unknown): Promise<ServiceCalls>
}

/** A state directory with one logged-in label `default` and an empty mirror, and the action tools to run in it. */
export function createActionFixture(): ActionFixture {
  const t = createSyncFixture()
  const target = { chat: USER, id: OWN_ID }
  const theirTarget = { chat: USER, id: THEIR_ID }
  return Object.assign(t, {
    own(overrides: Partial<MessageInput> = {}) {
      t.follow()
      t.store(outgoing({ id: OWN_ID, body: "old text", ...overrides }))
    },
    theirs(overrides: Partial<MessageInput> = {}) {
      t.follow()
      t.store({ id: THEIR_ID, body: "from Alice", ...overrides })
    },
    edit: (args: Record<string, unknown> = {}) => t.run(telegramMessageEdit, { ...target, text: "new text", ...args }),
    editFails: (args: Record<string, unknown> = {}) =>
      t.fail(telegramMessageEdit, { ...target, text: "new text", ...args }),
    serveEdit: (answer: (params: unknown) => unknown = () => EDITED) => t.serve({ edit: answer }),
    remove: (args: Record<string, unknown> = {}) => t.run(telegramMessageDelete, { ...target, ...args }),
    removeFails: (args: Record<string, unknown> = {}) => t.fail(telegramMessageDelete, { ...target, ...args }),
    serveDelete: (answer: (params: unknown) => unknown = () => DELETED) => t.serve({ delete: answer }),
    react: (args: Record<string, unknown> = {}) =>
      t.run(telegramMessageReact, { ...theirTarget, emoji: THUMBS_UP, ...args }),
    reactFails: (args: Record<string, unknown> = {}) =>
      t.fail(telegramMessageReact, { ...theirTarget, emoji: THUMBS_UP, ...args }),
    serveReact: (answer: (params: unknown) => unknown = () => REACTED) => t.serve({ react: answer }),
    pin: (args: Record<string, unknown> = {}) => t.run(telegramMessagePin, { ...theirTarget, ...args }),
    pinFails: (args: Record<string, unknown> = {}) => t.fail(telegramMessagePin, { ...theirTarget, ...args }),
    servePin: (answer: (params: unknown) => unknown = () => PINNED) => t.serve({ pin: answer }),
  })
}
