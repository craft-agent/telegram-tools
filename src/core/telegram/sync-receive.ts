import type { DeleteMessageUpdate, HistoryReadUpdate, Message } from "@mtcute/core"
import { deleteInputOf, readInputOf } from "./from-mtcute"
import { applyRead } from "./ingest-chats"
import { deleteMessages, type DeleteOutcome } from "./ingest-delete"
import { inTransaction, setMeta, type Mirror } from "./mirror"
import { META } from "./mirror-meta"
import type { DeleteInput, IngestContext, ReadInput } from "./mirror-input"
import { findChat } from "./mirror-rows"
import type { Coverage } from "./sync-coverage"
import type { FileKeeper } from "./sync-keep"
import { STORAGE_FAILURE_REASON, errorLabel } from "./sync-outcome"
import { readMessage, writeMessage, type ReadMessage } from "./sync-message"
import type { SyncTelegram } from "./sync-telegram"

/** What a handler reports for an update the mirror had no use for; it leaves `last_received_at` alone. */
const SKIPPED = "skipped"

export type ReceiverDeps = {
  mirror: Mirror
  now(): number
  /** Whether messages that disappear are kept. */
  keepDisappearing: boolean
  /** Whether channels are received. */
  channels: boolean
  /** Tells a delete whether the connection dropped since the last beat. */
  coverage: Coverage
  /** Receives one line per update: its kind and what became of it, never ids or text. */
  log(line: string): void
  /** Called once, synchronously, when the mirror cannot be written: whoever runs the client stops it there. */
  onStorageFailure(): void
}

/** The delete outcomes as counts per kind, such as `removed=2 tombstoned=1`. */
function countsOf(outcomes: DeleteOutcome[]): string {
  const counts = new Map<DeleteOutcome, number>()
  for (const outcome of outcomes) counts.set(outcome, (counts.get(outcome) ?? 0) + 1)
  return [...counts].map(([outcome, count]) => `${outcome}=${count}`).join(" ") || "none"
}

/**
 * Stores what the client pushes, one update in one transaction together with
 * `last_received_at`. An update the mirror cannot use is skipped. Any failure
 * of the write is a storage failure: receiving on with a mirror that cannot be
 * written would lose every update that follows, since the update state moves
 * on.
 */
export class Receiver {
  private readonly deps: ReceiverDeps
  private keeper: FileKeeper | undefined
  private halted = false

  constructor(deps: ReceiverDeps) {
    this.deps = deps
  }

  /**
   * Registers the handlers on the client's emitters; call it before the client
   * connects. `keeper` keeps the files of the disappearing messages that
   * arrive, when `keepDisappearing` is on.
   */
  attach(client: SyncTelegram, keeper: FileKeeper): void {
    this.keeper = keeper
    client.onNewMessage.add((message) => this.onMessage("message", message))
    client.onEditMessage.add((message) => this.onMessage("edit", message))
    client.onDeleteMessage.add((update) => this.onDelete(update))
    client.onHistoryRead.add((update) => this.onRead(update))
  }

  /** Stops storing: whatever arrives from here on is ignored. */
  halt(): void {
    this.halted = true
  }

  private onMessage(label: "message" | "edit", message: Message): void {
    const { channels, keepDisappearing } = this.deps
    const done = this.process<ReadMessage>(
      label,
      () => readMessage(message, channels),
      (read, ctx) => writeMessage(this.deps.mirror, ctx, read, channels),
    )
    // Only a new message is kept: an edit or a message the mirror had is not.
    if (keepDisappearing && label === "message" && done?.outcome === "stored") {
      this.keeper?.keep(message, done.prepared.message)
    }
  }

  private onDelete(update: DeleteMessageUpdate): void {
    const { mirror, coverage, keepDisappearing } = this.deps
    const done = this.process<DeleteInput>(
      "delete",
      () => deleteInputOf(update),
      (input, ctx) => {
        // A chat the mirror does not follow keeps nothing, not even the id of a deleted message.
        if (input.chat !== null && !findChat(mirror, input.chat)?.followed) return SKIPPED
        coverage.note(ctx.now)
        return countsOf(deleteMessages(mirror, ctx, input))
      },
    )
    if (keepDisappearing && done && done.outcome !== SKIPPED) {
      this.keeper?.forgetMessages(done.prepared.chat, done.prepared.ids)
    }
  }

  private onRead(update: HistoryReadUpdate): void {
    this.process<ReadInput>(
      "read",
      () => readInputOf(update),
      (input) => {
        applyRead(this.deps.mirror, input)
        return "applied"
      },
    )
  }

  /**
   * Turns the update into `prepared` outside the transaction, so that what
   * fails there is only mtcute's data, then writes it. `store` names the
   * outcome for the log. Resolves with `prepared` and the outcome once it is
   * written, and with null when the update was not (unreadable, not for the
   * mirror, or a storage failure).
   */
  private process<T>(
    label: string,
    prepare: () => T | null,
    store: (prepared: T, ctx: IngestContext) => string,
  ): { prepared: T; outcome: string } | null {
    if (this.halted) return null
    const { mirror, now, keepDisappearing, log } = this.deps
    let prepared: T | null
    try {
      prepared = prepare()
    } catch (error) {
      log(`event: ${label} unreadable (${errorLabel(error)})`)
      return null
    }
    if (prepared === null) {
      log(`event: ${label} ${SKIPPED}`)
      return null
    }
    let outcome: string
    try {
      const received = now()
      outcome = inTransaction(mirror, () => {
        const result = store(prepared, { now: received, keepDisappearing })
        if (result !== SKIPPED) setMeta(mirror, { [META.lastReceivedAt]: received })
        return result
      })
    } catch {
      this.failStorage()
      return null
    }
    log(`event: ${label} ${outcome}`)
    return { prepared, outcome }
  }

  private failStorage(): void {
    if (this.halted) return
    this.halted = true
    this.deps.onStorageFailure()
    this.deps.log(STORAGE_FAILURE_REASON)
  }
}
