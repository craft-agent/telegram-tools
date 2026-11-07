import { expireMessages, purge } from "./ingest-delete"
import { inTransaction, setMeta } from "./mirror"
import { META } from "./mirror-meta"
import type { ConnectionWatch, Coverage } from "./sync-coverage"
import { ConnectionLost, writing } from "./sync-ending"
import { seedRound, type BackgroundContext, type SeedTries } from "./sync-fetch"
import { refreshChats } from "./sync-refresh"
import { onAbort, realPause } from "./sync-wait"

export type HousekeepingContext = BackgroundContext & {
  coverage: Coverage
  watch: ConnectionWatch
}

/**
 * One beat: records a gap if the service stalled or the connection dropped
 * since the last one, writes `alive_at`, and lets messages whose timer ran out
 * go. Throws `ConnectionLost` once the connection has been down too long.
 */
function beat({ mirror, settings, coverage, watch }: HousekeepingContext): void {
  const now = settings.now()
  const gap = writing(() =>
    inTransaction(mirror, () => {
      const recorded = coverage.note(now)
      setMeta(mirror, { [META.aliveAt]: now })
      expireMessages(mirror, { now, keepDisappearing: settings.keepDisappearing })
      return recorded
    }),
  )
  if (gap) settings.log("a gap in watching (a stall or a dropped connection)")
  if (watch.downFor(now) > settings.offlineLimitMs) throw new ConnectionLost()
}

async function heartbeat(ctx: HousekeepingContext): Promise<void> {
  while (!ctx.signal.aborted) {
    beat(ctx)
    await realPause(ctx.settings.heartbeatEveryMs, ctx.signal)
  }
}

/** Purges, refreshes the chat list and seeds chats when each is due; first at the start, then every wake-up. */
async function rounds(ctx: HousekeepingContext): Promise<void> {
  const { mirror, settings, signal } = ctx
  const tries: SeedTries = new Map()
  let nextPurge = 0
  let nextRefresh = 0
  while (!signal.aborted) {
    const now = settings.now()
    if (now >= nextPurge) {
      writing(() => inTransaction(mirror, () => purge(mirror, now)))
      nextPurge = now + settings.purgeEveryMs
    }
    if (now >= nextRefresh) {
      const refreshed = await refreshChats(ctx)
      nextRefresh = settings.now() + (refreshed ? settings.refreshEveryMs : settings.refreshRetryMs)
    }
    const seeded = await seedRound(ctx, tries)
    if (seeded > 0) settings.log(`seeded ${seeded} chats`)
    await realPause(settings.roundEveryMs, signal)
  }
}

/**
 * The service's upkeep until `signal` aborts: the heartbeat every few seconds,
 * and beside it the rounds, which can take minutes on a paced fetch and must
 * not stall the beat. Rejects with whatever ends the service: Telegram ending
 * the session, a mirror that cannot be written, a connection down for too
 * long. A failure of either loop ends the other.
 */
export async function runHousekeeping(ctx: HousekeepingContext): Promise<void> {
  ctx.watch.forgetDrops()
  const stopped = new AbortController()
  const stopListening = onAbort(ctx.signal, () => stopped.abort())
  const inner = { ...ctx, signal: stopped.signal }
  let failure: { error: unknown } | undefined
  const run = (loop: (ctx: HousekeepingContext) => Promise<void>) =>
    loop(inner).catch((error) => {
      failure ??= { error }
      stopped.abort()
    })
  await Promise.all([run(heartbeat), run(rounds)])
  stopListening()
  if (failure) throw failure.error
}
