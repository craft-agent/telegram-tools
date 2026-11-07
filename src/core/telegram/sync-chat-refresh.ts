import { ToolError } from "../errors"
import { getMeta } from "./mirror"
import { META } from "./mirror-meta"
import { abortable } from "./sync-request-errors"
import { refreshChats, type RefreshListener } from "./sync-refresh"
import type { BackgroundContext } from "./sync-fetch"

/** A refresh that finished less than this long ago is not repeated for a request. */
export const REFRESH_REUSE_MS = 60_000

/** What a request is told when the service stops before the chat list was read. */
const STOPPING = "The sync service is stopping."

/** One refresh in flight: when the chat list is settled, and when the whole round (gap filling too) is. */
type Round = { listed: Promise<void>; done: Promise<boolean> }

/**
 * Runs the chat list refresh for the housekeeping and for the `refresh`
 * request, never two at once: whoever asks while a round runs joins it. A
 * request waits only for the list, not for the gap filling after it, and a
 * round that failed answers it at once, not after a flood wait is waited out.
 */
export class ChatListRefresh {
  private readonly ctx: BackgroundContext
  private current: Round | undefined

  constructor(ctx: BackgroundContext) {
    this.ctx = ctx
  }

  /** The housekeeping's refresh: joins the round in flight or starts one, and resolves with its result as `refreshChats` gives it. */
  round(): Promise<boolean> {
    return (this.current ?? this.begin()).done
  }

  /**
   * The `refresh` request: the time of a refresh that finished within
   * `REFRESH_REUSE_MS`, else of the one it waited for. Rejects with whatever
   * made the list unreadable, or as cancelled when `signal` aborts.
   */
  async request(signal: AbortSignal): Promise<number> {
    const recent = this.recentRefresh()
    if (recent !== undefined) return recent
    await abortable((this.current ?? this.begin()).listed, signal)
    const refreshedAt = this.refreshedAt()
    if (refreshedAt === undefined) throw new ToolError("internal_error", "The chat list was refreshed without a time.")
    return refreshedAt
  }

  /** When the chat list was last stored, or undefined when it never was. */
  private refreshedAt(): number | undefined {
    const stored = Number(getMeta(this.ctx.mirror)[META.refreshedAt])
    return Number.isFinite(stored) ? stored : undefined
  }

  /** The time of the last refresh when it was within `REFRESH_REUSE_MS` of now. */
  private recentRefresh(): number | undefined {
    const refreshedAt = this.refreshedAt()
    if (refreshedAt === undefined) return undefined
    const age = this.ctx.settings.now() - refreshedAt
    return age >= 0 && age < REFRESH_REUSE_MS ? refreshedAt : undefined
  }

  private begin(): Round {
    let listener!: RefreshListener
    const listed = new Promise<void>((resolve, reject) => {
      listener = { listed: resolve, failed: reject }
    })
    // Nobody may be waiting for it: a rejection must not go unhandled.
    listed.catch(() => {})
    const done = refreshChats(this.ctx, listener)
    const round: Round = { listed, done }
    this.current = round
    const ended = (failure?: unknown) => {
      // A no-op when the list has settled already; otherwise the round ended before it got to the list.
      if (failure !== undefined) listener.failed(failure)
      if (this.current === round) this.current = undefined
    }
    done.then((refreshed) => ended(refreshed ? undefined : new ToolError("upstream_error", STOPPING)), ended)
    return round
  }
}
