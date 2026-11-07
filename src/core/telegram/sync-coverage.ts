import type { ConnectionState } from "@mtcute/core"
import { recordGap } from "./ingest-delete"
import type { Mirror } from "./mirror"

/** Follows the client's connection state: whether it is up, since when, and whether it dropped. */
export class ConnectionWatch {
  private up = false
  private upSince: number | null = null
  private downSince: number | null
  private dropped = false
  private readonly now: () => number

  constructor(now: () => number) {
    this.now = now
    this.downSince = now()
  }

  /** The listener for the client's connection state; `updating` and `connected` are both up. */
  readonly observe = (state: ConnectionState): void => {
    const connected = state === "connected" || state === "updating"
    if (!connected) this.dropped = true
    if (connected === this.up) return
    this.up = connected
    this.upSince = connected ? this.now() : null
    this.downSince = connected ? null : this.now()
  }

  get connected(): boolean {
    return this.up
  }

  /** When the connection last came up, or null while it is down. */
  get since(): number | null {
    return this.upSince
  }

  /** How long the connection has been down at `now`; 0 while it is up. */
  downFor(now: number): number {
    return this.downSince === null ? 0 : now - this.downSince
  }

  /** Forgets the drops so far: what happened before the service started watching is not a gap in its watching. */
  forgetDrops(): void {
    this.dropped = false
  }

  /** Whether the connection went offline or reconnected since the last call; the next call starts afresh. */
  takeDropped(): boolean {
    const dropped = this.dropped
    this.dropped = false
    return dropped
  }
}

/**
 * Which stretches the service did not watch. Deletes carry no time, so the
 * mirror needs to know when updates may have been held back: a stall (a
 * sleeping machine) or a dropped connection since the last beat is recorded
 * as a gap.
 */
export class Coverage {
  private lastBeat: number
  private readonly mirror: Mirror
  private readonly watch: ConnectionWatch
  private readonly gapAfterMs: number

  constructor(mirror: Mirror, watch: ConnectionWatch, gapAfterMs: number, startedAt: number) {
    this.mirror = mirror
    this.watch = watch
    this.gapAfterMs = gapAfterMs
    this.lastBeat = startedAt
  }

  /**
   * Moves the beat to `now`, and records the span since the last beat as a gap
   * when more than `gapAfterMs` passed or the connection dropped meanwhile.
   * Writes to the mirror: call it inside a transaction. Returns whether a gap
   * was recorded.
   */
  note(now: number): boolean {
    const gap = this.watch.takeDropped() || now - this.lastBeat > this.gapAfterMs
    if (gap) recordGap(this.mirror, this.lastBeat, now)
    this.lastBeat = now
    return gap
  }
}
