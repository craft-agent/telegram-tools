import { isSessionEnded } from "./rpc-errors"
import { failureReason, type Ended } from "./sync-outcome"

/** Thrown when a write to the mirror failed: the service stops rather than miss what follows. */
export class StorageFailure extends Error {
  constructor(options?: { cause?: unknown }) {
    super("the mirror cannot be written", options)
    this.name = "StorageFailure"
  }
}

/** Thrown when the connection stayed down for longer than the service waits for it. */
export class ConnectionLost extends Error {
  constructor() {
    super("the connection stayed down")
    this.name = "ConnectionLost"
  }
}

/** Runs `work`, which writes to the mirror, and turns anything it throws into a `StorageFailure`. */
export function writing<T>(work: () => T): T {
  try {
    return work()
  } catch (error) {
    throw new StorageFailure({ cause: error })
  }
}

/** What a failure that nobody handled ends the run as. */
export function endedBy(error: unknown): Ended {
  if (isSessionEnded(error)) return { kind: "session-ended" }
  if (error instanceof StorageFailure) return { kind: "storage" }
  if (error instanceof ConnectionLost) return { kind: "connection" }
  return { kind: "error", reason: failureReason(error) }
}

/** The one reason a run ends for: whichever comes first wins. */
export class Ending {
  /** Resolves with the first reason given to `end`. */
  readonly promise: Promise<Ended>
  private readonly controller = new AbortController()
  private resolve: (ended: Ended) => void = () => {}
  private result: Ended | undefined

  constructor() {
    this.promise = new Promise((resolve) => (this.resolve = resolve))
  }

  /** Aborts once the run has ended, so everything waiting on it gives up. */
  get signal(): AbortSignal {
    return this.controller.signal
  }

  get settled(): boolean {
    return this.result !== undefined
  }

  end(ended: Ended): void {
    if (this.result) return
    this.result = ended
    this.resolve(ended)
    this.controller.abort()
  }
}
