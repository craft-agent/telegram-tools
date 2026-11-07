import { existsSync } from "node:fs"
import { isToolError } from "../errors"
import { readApp, type AppCredentials } from "./app"
import { recordGap } from "./ingest-delete"
import { labelPaths, type LabelPaths } from "./labels"
import { getMeta, openMirrorForWrite, setMeta, type Mirror } from "./mirror"
import { META, SYNC_STATUS, recordStatus } from "./mirror-meta"
import { isSessionEnded } from "./rpc-errors"
import { serveService, type ServiceServer } from "./service-server"
import { LOCK_HELD_REASON, acquireSyncLock } from "./sync-lock"
import { ChatListRefresh } from "./sync-chat-refresh"
import { ConnectionWatch, Coverage } from "./sync-coverage"
import { Ending, endedBy, writing } from "./sync-ending"
import { runHousekeeping } from "./sync-housekeeping"
import { resolveOptions, type ResolvedSyncOptions, type SyncOptions } from "./sync-options"
import {
  NOT_LOGGED_IN_MESSAGE,
  NO_APP_MESSAGE,
  OTHER_ACCOUNT_REASON,
  errorLabel,
  settle,
  type Ended,
  type SyncOutcome,
} from "./sync-outcome"
import { Receiver } from "./sync-receive"
import { syncRequestHandlers } from "./sync-requests"
import type { SyncTelegram } from "./sync-telegram"
import { onAbort, settledOrTimeout } from "./sync-wait"

export type { SyncOptions } from "./sync-options"
export type { SyncOutcome } from "./sync-outcome"
export type { OpenClient, SyncTelegram } from "./sync-telegram"

const NOT_LOGGED_IN: SyncOutcome = { exitCode: 0, status: "not logged in" }

/** What a run has started so far, for its end to stop. */
type Session = {
  client?: SyncTelegram
  server?: ServiceServer
  /** The socket being opened, which may settle after the run has shut down. */
  serverStarting?: Promise<ServiceServer>
  /** The start-up, which settles once the service runs or has ended. */
  starting?: Promise<void>
  housekeeping?: Promise<void>
}

/** What one run works on. */
type Run = {
  mirror: Mirror
  paths: LabelPaths
  app: AppCredentials
  settings: ResolvedSyncOptions
  ending: Ending
  receiver: Receiver
  watch: ConnectionWatch
  coverage: Coverage
}

/** Records how the run ended, as far as the mirror can be written, tells the log, and returns the outcome. */
function finish(mirror: Mirror | undefined, settings: ResolvedSyncOptions, ended: Ended): SyncOutcome {
  const settled = settle(ended)
  if (mirror) {
    try {
      recordStatus(mirror, settled.status, settled.error, settings.now())
      if (ended.kind === "stop") setMeta(mirror, { [META.aliveAt]: settings.now() })
    } catch {
      // A mirror that cannot be written cannot say so; the log and the outcome do.
    }
  }
  settings.log(settled.message)
  return settled.outcome
}

/** Records the start, and the span since the last beat of the run before as a gap in watching. */
function recordStart(mirror: Mirror, startedAt: number): void {
  const previousBeat = Number(getMeta(mirror)[META.aliveAt])
  recordStatus(mirror, SYNC_STATUS.starting, null, startedAt)
  recordGap(mirror, previousBeat, startedAt)
}

/** Connects, checks whose mirror this is, and starts the updates, the socket and the housekeeping. */
async function start(run: Run, session: Session): Promise<void> {
  const { mirror, paths, app, settings, ending, receiver, watch, coverage } = run
  const { log } = settings
  // Before connecting: the catch-up replays what happened while the service was down as soon as the updates start.
  const client = settings.openClient(app)
  session.client = client
  receiver.attach(client)
  client.onConnectionState.add(watch.observe)
  client.onError.add((error) => {
    if (isSessionEnded(error)) ending.end({ kind: "session-ended" })
    else if (!ending.settled) log(`client error: ${errorLabel(error)}`)
  })

  await client.connect()
  const me = await client.getMe()
  if (ending.settled) return
  if (!watch.connected) watch.observe("connected")

  const account = String(me.id)
  const known = writing(() => getMeta(mirror)[META.accountId])
  if (known !== undefined && known !== account) {
    ending.end({ kind: "error", reason: OTHER_ACCOUNT_REASON })
    return
  }
  writing(() =>
    setMeta(mirror, {
      [META.accountId]: account,
      [META.accountName]: me.displayName,
      [META.connectedAt]: settings.now(),
    }),
  )

  await client.startUpdatesLoop()
  if (ending.settled) return
  const refresh = new ChatListRefresh({ client, mirror, settings, signal: ending.signal })
  const requests = syncRequestHandlers({
    client,
    mirror,
    settings,
    signal: ending.signal,
    refresh,
    endSession: () => ending.end({ kind: "session-ended" }),
  })
  session.serverStarting = serveService(
    paths.socket,
    { status: async () => ({ connected: watch.connected, since: watch.since, account }), ...requests },
    { onError: (error, method) => log(`request failed: ${method} (${errorLabel(error)})`) },
  )
  session.server = await session.serverStarting
  if (ending.settled) return
  writing(() => recordStatus(mirror, SYNC_STATUS.running, null, settings.now()))
  log("connected")
  session.housekeeping = runHousekeeping({
    client,
    mirror,
    settings,
    signal: ending.signal,
    coverage,
    watch,
    refresh,
  }).catch((error) => ending.end(endedBy(error)))
}

/** Closes what the run started: stops storing, closes the socket, destroys the client, and waits for the upkeep to end. */
async function shutDown(run: Run, session: Session): Promise<void> {
  const { receiver, settings } = run
  const { stopWaitMs } = settings
  receiver.halt()
  if (session.server) await settledOrTimeout(session.server.close(), stopWaitMs)
  // A socket still being opened is closed when it is ready, even after the wait below has given up on it.
  const lateClose = session.server ? undefined : session.serverStarting?.then((server) => server.close())
  lateClose?.catch(() => {})
  if (session.client) await settledOrTimeout(session.client.destroy(), stopWaitMs)
  await settledOrTimeout(Promise.all([session.starting, session.housekeeping, lateClose]), stopWaitMs)
}

/** Everything from recording the start to the outcome, with the mirror open and the app's credentials read. */
async function syncWithMirror(mirror: Mirror, paths: LabelPaths, app: AppCredentials, settings: ResolvedSyncOptions) {
  const startedAt = settings.now()
  const ending = new Ending()
  const watch = new ConnectionWatch(settings.now)
  const coverage = new Coverage(mirror, watch, settings.gapAfterMs, startedAt)
  const session: Session = {}
  let frozen = false
  const freezeStorage = () => {
    if (frozen) return
    frozen = true
    session.client?.freezeStorage()
  }
  const receiver = new Receiver({
    mirror,
    now: settings.now,
    keepDisappearing: settings.keepDisappearing,
    channels: settings.channels,
    coverage,
    log: settings.log,
    onStorageFailure: () => {
      // Before the handler returns: mtcute has moved its update state past this update and saves it after the handler.
      freezeStorage()
      ending.end({ kind: "storage" })
    },
  })
  const run: Run = { mirror, paths, app, settings, ending, receiver, watch, coverage }
  // A storage failure from elsewhere (the upkeep) freezes the session storage too, as soon as the run is known to end.
  void ending.promise.then((ended) => {
    if (ended.kind === "storage") freezeStorage()
  })
  const stopListening = onAbort(settings.signal, () => ending.end({ kind: "stop" }))
  try {
    writing(() => recordStart(mirror, startedAt))
    settings.log("starting")
    if (!ending.settled) session.starting = start(run, session).catch((error) => ending.end(endedBy(error)))
  } catch (error) {
    ending.end(endedBy(error))
  }
  const ended = await ending.promise
  stopListening()
  await shutDown(run, session)
  return finish(mirror, settings, ended)
}

/** The checks that need the label's lock, then the run itself. */
async function syncLocked(paths: LabelPaths, settings: ResolvedSyncOptions): Promise<SyncOutcome> {
  let mirror: Mirror
  try {
    mirror = openMirrorForWrite(paths.mirror)
  } catch (error) {
    if (!isToolError(error)) throw error
    return finish(undefined, settings, { kind: "error", reason: error.message })
  }
  try {
    let app: AppCredentials
    try {
      app = readApp(paths.app)
    } catch (error) {
      if (!isToolError(error)) throw error
      if (error.code !== "not_found") return finish(mirror, settings, { kind: "error", reason: error.message })
      settings.log(NO_APP_MESSAGE)
      return NOT_LOGGED_IN
    }
    return await syncWithMirror(mirror, paths, app, settings)
  } finally {
    mirror.close()
  }
}

/**
 * Keeps one label's mirror current: connects with the label's session,
 * receives what Telegram pushes, answers `status` on the label's socket, and
 * keeps the mirror up to date in the background (heartbeat, expiry, the chat
 * list, gaps and seeding).
 *
 * One run per label: it holds the label's lock for as long as it runs, and a
 * second run resolves as `failed` at once, touching nothing. A label with no
 * session, or no app credentials, resolves as `not logged in` (exit code 0).
 *
 * Resolves once the run ended, with nothing left running: no timer, socket or
 * client. A stop request resolves as `stopped` (exit code 0). Telegram ending
 * the session resolves as `logged out` (exit code 0): the service stays down
 * until the label logs in again. Every other end is `failed` (exit code 1),
 * a mirror that cannot be written among them.
 */
export async function runSync(options: SyncOptions): Promise<SyncOutcome> {
  const settings = resolveOptions(options)
  const { log } = settings
  const paths = labelPaths(settings.stateDir, settings.label)
  if (!existsSync(paths.dir) || !existsSync(paths.session)) {
    log(NOT_LOGGED_IN_MESSAGE)
    return NOT_LOGGED_IN
  }

  const release = acquireSyncLock(paths.syncLock)
  if (!release) {
    log(LOCK_HELD_REASON)
    return { exitCode: 1, status: "failed", reason: LOCK_HELD_REASON }
  }
  try {
    return await syncLocked(paths, settings)
  } finally {
    release()
  }
}
