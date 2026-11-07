import { inTransaction, getMeta, setMeta, type Mirror } from "./mirror"

/** The keys of the mirror's `meta` table that the sync service and its readers share. */
export const META = {
  /** The sync service's status, one of `SYNC_STATUS`. */
  status: "status",
  /** Why the service failed or stopped, if it did; absent otherwise. */
  error: "error",
  /** When the service started (ms timestamp). */
  startedAt: "started_at",
  /** When the service last connected to Telegram (ms timestamp). */
  connectedAt: "connected_at",
  /** The service's last heartbeat (ms timestamp). */
  aliveAt: "alive_at",
  /** When the chat list was last refreshed (ms timestamp). */
  refreshedAt: "refreshed_at",
  /** When the service last received a message (ms timestamp). */
  lastReceivedAt: "last_received_at",
  /** The id of the account the mirror's messages belong to. */
  accountId: "account_id",
  /** The account's display name. */
  accountName: "account_name",
} as const

/** The values of the `status` key. */
export const SYNC_STATUS = {
  starting: "starting",
  running: "running",
  stopped: "stopped",
  loggedOut: "logged out",
  failed: "failed",
} as const

/** Where the sync service of a label stands, as the mirror's `status` records it. */
export type SyncStatus = (typeof SYNC_STATUS)[keyof typeof SYNC_STATUS]

/** What the mirror says about the service's state. */
export type RecordedStatus = { status: SyncStatus; error?: string }

const STATUS_VALUES: readonly string[] = Object.values(SYNC_STATUS)

/**
 * Records the status and its error (`null` for none) in the mirror's `meta`, in one transaction.
 * `starting` also records `now` as `started_at`.
 */
export function recordStatus(mirror: Mirror, status: SyncStatus, error: string | null, now: number): void {
  inTransaction(mirror, () =>
    setMeta(mirror, {
      [META.status]: status,
      [META.error]: error,
      ...(status === SYNC_STATUS.starting ? { [META.startedAt]: now } : {}),
    }),
  )
}

/** The recorded status, or undefined when none was recorded or the value is not a known status. */
export function readStatus(mirror: Mirror): RecordedStatus | undefined {
  const meta = getMeta(mirror)
  const status = meta[META.status]
  if (status === undefined || !STATUS_VALUES.includes(status)) return undefined
  const error = meta[META.error]
  return error === undefined ? { status: status as SyncStatus } : { status: status as SyncStatus, error }
}
