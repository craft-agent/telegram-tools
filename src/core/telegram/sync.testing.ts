import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { Dialog, type Message, type tl } from "@mtcute/core"
import { writeApp } from "./app"
import {
  FAKE_DATE,
  dialogMessages,
  fakeBasicGroup,
  fakeBot,
  fakeChannel,
  fakeDialog,
  fakeMessage,
  fakeSupergroup,
  fakeUser,
  messageOf,
  peersOf,
} from "./fake-telegram.testing"
import { labelPaths, type LabelPaths } from "./labels"
import { getMeta, openMirrorForRead, openMirrorForWrite, type Mirror } from "./mirror"
import { makeTempDir } from "./mirror.testing"
import { createFakeSyncClient, type FakeSyncClient } from "./sync-client.testing"
import { runSync, type SyncOptions, type SyncOutcome } from "./sync"

export const LABEL = "main"

/** The moment the fake clock starts at: a minute after the fake messages were sent. */
export const START_MS = FAKE_DATE * 1000 + 60_000

/** A made-up app, as `my.telegram.org` would give. */
const APP = { apiId: 123456, apiHash: "0123456789abcdef0123456789abcdef" }

const DIR_MODE = 0o700

/** Timings short enough for a test; the values are not what the defaults are. Only the first chat-list refresh falls due. */
const TEST_OPTIONS = {
  heartbeatEveryMs: 20,
  roundEveryMs: 20,
  refreshEveryMs: 1_000_000_000,
  refreshRetryMs: 1_000_000_000,
  stopWaitMs: 2_000,
}

/** How long a test waits for something the service does on its own. */
const EVENTUALLY_MS = 8_000

/** A sync test's surroundings: a state directory with a logged-in label, a fake client, a fake clock, and what the service logged. */
export type SyncFixture = {
  stateDir: string
  paths: LabelPaths
  client: FakeSyncClient
  /** Every line handed to `log`. */
  logs: string[]
  /** The milliseconds every `pause` was asked for, in order; none waits. */
  pauses: number[]
  /** The clock the service reads; it stays where it is until a test moves it. */
  clock: { now: number; advance(ms: number): void }
  /** Runs the service on `LABEL` with test timings, unless `overrides` say otherwise. */
  run(overrides?: Partial<SyncOptions>): Promise<SyncOutcome>
  /** Starts a run that a test stops itself; `stop` aborts it. */
  start(overrides?: Partial<SyncOptions>): { outcome: Promise<SyncOutcome>; stop(): void }
  /** Starts a run and waits until the mirror says it is running. */
  running(overrides?: Partial<SyncOptions>): Promise<{ outcome: Promise<SyncOutcome>; stop(): void }>
  /** The mirror's `meta`, read the way a tool reads it; empty while there is no mirror yet. */
  meta(): Record<string, string>
  /** Runs `read` on the mirror opened the way a tool opens it. */
  mirror<T>(read: (mirror: Mirror) => T): T
  /** Writes into the label's mirror, the way an earlier run left it; call it before the service runs. */
  seed(write: (mirror: Mirror) => void): void
  /** Stops every run still going, waits for them, and removes the state directory. */
  close(): Promise<void>
}

/** Every fake peer, so that a dialog or a message can be made for any of them. */
const ALL_PEERS = [fakeUser(), fakeBot(), fakeBasicGroup(), fakeSupergroup(), fakeChannel()]

/** A new message from Alice in her private chat, as the client pushes it. */
export function aliceMessage(id = 1, text = "hello"): Message {
  return messageOf(fakeMessage({ id, message: text }), fakeUser())
}

/** Messages with these ids in the chat of `peer`, as a history fetch returns them. */
export function fakeHistory(peer: tl.TypePeer, ...ids: number[]): Message[] {
  return ids.map((id) => messageOf(fakeMessage({ id, peerId: peer }), ...ALL_PEERS))
}

/** The dialog of `peer` whose newest message is `topMessage`, sent at `date` (Unix seconds); 2 unread, read up to 8. */
export function fakeDialogFor(peer: tl.TypePeer, topMessage = 9, date = FAKE_DATE): Dialog {
  const newest = fakeMessage({ id: topMessage, peerId: peer, date })
  return new Dialog(fakeDialog(peer, { topMessage }), peersOf(...ALL_PEERS), dialogMessages(newest))
}

/** Sets up a sync test with a logged-in label (a session file and the app's credentials); call `close` afterwards. */
export function syncFixture(): SyncFixture {
  const stateDir = makeTempDir()
  const paths = labelPaths(stateDir, LABEL)
  mkdirSync(paths.dir, { recursive: true, mode: DIR_MODE })
  writeFileSync(paths.session, "")
  writeApp(paths.app, APP)
  const client = createFakeSyncClient()
  const logs: string[] = []
  const pauses: number[] = []
  const clock = {
    now: START_MS,
    advance(ms: number) {
      clock.now += ms
    },
  }

  const run: SyncFixture["run"] = (overrides = {}) =>
    runSync({
      stateDir,
      label: LABEL,
      keepDisappearing: false,
      channels: false,
      openClient: () => client,
      log: (line) => logs.push(line),
      now: () => clock.now,
      pause: async (ms) => void pauses.push(ms),
      ...TEST_OPTIONS,
      ...overrides,
    })

  const mirror: SyncFixture["mirror"] = (read) => {
    const opened = openMirrorForRead(paths.mirror)
    try {
      return read(opened)
    } finally {
      opened.close()
    }
  }

  const meta = () => {
    if (!existsSync(paths.mirror)) return {}
    try {
      return mirror(getMeta)
    } catch {
      return {} // being set up
    }
  }

  const started: ReturnType<SyncFixture["start"]>[] = []
  const start: SyncFixture["start"] = (overrides = {}) => {
    const controller = new AbortController()
    const handle = { outcome: run({ signal: controller.signal, ...overrides }), stop: () => controller.abort() }
    started.push(handle)
    return handle
  }

  return {
    stateDir,
    paths,
    client,
    logs,
    pauses,
    clock,
    run,
    start,
    async running(overrides = {}) {
      const started = start(overrides)
      await eventually(() => meta().status === "running")
      return started
    },
    meta,
    mirror,
    seed(write) {
      const opened = openMirrorForWrite(paths.mirror)
      try {
        write(opened)
      } finally {
        opened.close()
      }
    },
    async close() {
      for (const { stop } of started) stop()
      await Promise.allSettled(started.map(({ outcome }) => outcome))
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
}

/** Polls until `condition` holds, failing the test after `ms`. */
export async function eventually(condition: () => boolean, ms = EVENTUALLY_MS): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
