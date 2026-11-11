import type { OpenClient } from "./sync-telegram"
import { realPause, type Pause } from "./sync-wait"

const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * Bounds a download's or an upload's wait for the next part, in milliseconds.
 * mtcute waits out flood waits and retries failed parts inside either without
 * end; this is what bounds those sleeps and retries.
 */
export const TRANSFER_STALL_MS = 60_000

/** How often the heartbeat writes `alive_at` and lets expired messages go. */
const DEFAULT_HEARTBEAT_EVERY_MS = 5 * SECOND_MS
/** More than this between two beats is a stall (a sleeping machine, a frozen process) and is recorded as a gap. */
const DEFAULT_GAP_AFTER_MS = 30 * SECOND_MS
/** How long the connection may stay down before the service gives up and lets its supervisor restart it. */
const DEFAULT_OFFLINE_LIMIT_MS = 10 * MINUTE_MS
/** How often tombstones and gaps past their time are forgotten. */
const DEFAULT_PURGE_EVERY_MS = HOUR_MS
/** How often the chat list is read again and gaps in followed chats are filled. */
const DEFAULT_REFRESH_EVERY_MS = 30 * MINUTE_MS
/** How long after a refresh that failed the next one is tried. */
const DEFAULT_REFRESH_RETRY_MS = MINUTE_MS
/** How long the housekeeping rounds (which seed chats) are apart. */
const DEFAULT_ROUND_EVERY_MS = 5 * SECOND_MS
/** How long closing the server, the housekeeping and the client may take once the service ends. */
const DEFAULT_STOP_WAIT_MS = 10 * SECOND_MS
/** A chat with no stored messages whose last activity is older than this is not seeded. */
const DEFAULT_SEED_WITHIN_MS = 30 * DAY_MS
/** How many of its newest messages a chat gets when it is seeded. */
const DEFAULT_SEED_COUNT = 50
/** How many chats one round seeds at most. */
const DEFAULT_SEED_CHATS_PER_ROUND = 20
/** How often seeding a chat is tried before it is given up for this run. */
const DEFAULT_SEED_ATTEMPTS = 3
/** How many messages above the newest stored one are fetched to fill a gap in a chat. */
const DEFAULT_FILL_LIMIT = 200
/** The random pause before each background fetch: the shortest and the longest, in milliseconds. */
const DEFAULT_PACE_MS: readonly [number, number] = [500, 1500]

/** What `runSync` takes; everything after `signal` is a test override with a default. */
export type SyncOptions = {
  stateDir: string
  label: string
  /** Whether messages that disappear are kept (the `keep_disappearing` setting). */
  keepDisappearing: boolean
  /** Whether channels are listed and their messages received (the `channels` setting). */
  channels: boolean
  /** Builds the client; the command line passes one made by `createTelegramClient`. */
  openClient: OpenClient
  /** Receives each line of the service's log: kinds, counts and RPC error names, never content, ids or names. */
  log(line: string): void
  /** A stop request: the service closes its socket and client, records `stopped` and resolves. */
  signal?: AbortSignal
  /** The clock for every time the service compares or stores, in milliseconds; `Date.now` by default. */
  now?: () => number
  /** What the pacing between background fetches and a flood wait wait through; a real timer that `signal` cuts short by default. */
  pause?: Pause
  /** How often the heartbeat beats; 5 seconds by default. */
  heartbeatEveryMs?: number
  /** The time between two beats that counts as a gap in watching; 30 seconds by default. */
  gapAfterMs?: number
  /** How long the connection may stay down before the run fails; 10 minutes by default. */
  offlineLimitMs?: number
  /** How often tombstones and old gaps are purged; 1 hour by default. */
  purgeEveryMs?: number
  /** How often the chat list is refreshed; 30 minutes by default. */
  refreshEveryMs?: number
  /** How long after a failed refresh the next one is tried; 1 minute by default. */
  refreshRetryMs?: number
  /** How long the housekeeping rounds are apart; 5 seconds by default. */
  roundEveryMs?: number
  /** How long closing things down may take; 10 seconds by default. */
  stopWaitMs?: number
  /** How recent a chat's last activity must be for it to be seeded; 30 days by default. */
  seedWithinMs?: number
  /** The newest messages a seeded chat gets; 50 by default. */
  seedCount?: number
  /** The chats seeded per round; 20 by default. */
  seedChatsPerRound?: number
  /** The tries to seed one chat per run; 3 by default. */
  seedAttempts?: number
  /** The messages fetched to fill a gap in one chat; 200 by default. */
  fillLimit?: number
  /** The shortest and the longest random pause before a background fetch; 0.5 and 1.5 seconds by default. */
  paceMs?: readonly [number, number]
  /** How long a download may receive nothing, or an upload move no byte, before it stops; 60 seconds by default. */
  transferStallMs?: number
}

/** `SyncOptions` with every default filled in. */
export type ResolvedSyncOptions = Required<Omit<SyncOptions, "signal">> & { signal?: AbortSignal }

export function resolveOptions(options: SyncOptions): ResolvedSyncOptions {
  return {
    ...options,
    now: options.now ?? Date.now,
    pause: options.pause ?? realPause,
    heartbeatEveryMs: options.heartbeatEveryMs ?? DEFAULT_HEARTBEAT_EVERY_MS,
    gapAfterMs: options.gapAfterMs ?? DEFAULT_GAP_AFTER_MS,
    offlineLimitMs: options.offlineLimitMs ?? DEFAULT_OFFLINE_LIMIT_MS,
    purgeEveryMs: options.purgeEveryMs ?? DEFAULT_PURGE_EVERY_MS,
    refreshEveryMs: options.refreshEveryMs ?? DEFAULT_REFRESH_EVERY_MS,
    refreshRetryMs: options.refreshRetryMs ?? DEFAULT_REFRESH_RETRY_MS,
    roundEveryMs: options.roundEveryMs ?? DEFAULT_ROUND_EVERY_MS,
    stopWaitMs: options.stopWaitMs ?? DEFAULT_STOP_WAIT_MS,
    seedWithinMs: options.seedWithinMs ?? DEFAULT_SEED_WITHIN_MS,
    seedCount: options.seedCount ?? DEFAULT_SEED_COUNT,
    seedChatsPerRound: options.seedChatsPerRound ?? DEFAULT_SEED_CHATS_PER_ROUND,
    seedAttempts: options.seedAttempts ?? DEFAULT_SEED_ATTEMPTS,
    fillLimit: options.fillLimit ?? DEFAULT_FILL_LIMIT,
    paceMs: options.paceMs ?? DEFAULT_PACE_MS,
    transferStallMs: options.transferStallMs ?? TRANSFER_STALL_MS,
  }
}
