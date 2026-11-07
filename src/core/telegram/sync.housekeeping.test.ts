import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { FAKE_MARKED, fakeMessage, fakeUser, messageOf } from "./fake-telegram.testing"
import { TOMBSTONE_TTL_MS } from "./ingest-delete"
import { recordDeleted } from "./mirror-rows"
import { messageRow, rowsOf } from "./mirror.testing"
import { START_MS, aliceMessage, eventually, syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeEach(() => {
  fixture = syncFixture()
})

afterEach(() => fixture.close())

const gaps = () => fixture.mirror((m) => rowsOf(m, "SELECT start, until FROM gaps"))

describe("the heartbeat", () => {
  test("writes alive_at on every beat", async () => {
    await fixture.running()

    fixture.clock.advance(10_000)

    await eventually(() => fixture.meta().alive_at === String(START_MS + 10_000))
    expect(gaps()).toEqual([])
  })

  test("records the span since the last beat as a gap when more than 30 seconds passed", async () => {
    await fixture.running()

    fixture.clock.advance(60_000)

    await eventually(() => gaps().length === 1)
    expect(gaps()).toEqual([{ start: START_MS, until: START_MS + 60_000 }])
    expect(fixture.logs.some((line) => line.startsWith("a gap in watching"))).toBe(true)
  })

  test("records a gap when the connection dropped since the last beat, however short the span", async () => {
    await fixture.running({ heartbeatEveryMs: 50 })

    fixture.client.drop()
    fixture.clock.advance(1_000)
    fixture.client.regain()

    await eventually(() => gaps().length === 1)
    expect(gaps()).toEqual([{ start: START_MS, until: START_MS + 1_000 }])
  })

  test("records one gap for one drop", async () => {
    await fixture.running({ heartbeatEveryMs: 20 })

    fixture.client.drop()
    fixture.clock.advance(1_000)
    fixture.client.regain()
    await eventually(() => gaps().length === 1)
    fixture.clock.advance(1_000)
    await eventually(() => fixture.meta().alive_at === String(START_MS + 2_000))

    expect(gaps()).toHaveLength(1)
  })
})

describe("messages that disappear", () => {
  /** A message on a 2-minute timer, sent a minute before the clock starts. */
  const timed = () => messageOf(fakeMessage({ id: 1, ttlPeriod: 120 }), fakeUser())

  test("leave on the beat after their timer runs out", async () => {
    await fixture.running()
    fixture.client.onNewMessage.emit(timed())
    expect(fixture.mirror((m) => messageRow(m, FAKE_MARKED.alice, 1))).toBeDefined()

    fixture.clock.advance(90_000)

    await eventually(() => fixture.mirror((m) => messageRow(m, FAKE_MARKED.alice, 1)) === undefined)
  })

  test("are kept, marked as kept, with keep_disappearing on", async () => {
    await fixture.running({ keepDisappearing: true })
    fixture.client.onNewMessage.emit(timed())

    fixture.clock.advance(90_000)

    await eventually(() => fixture.mirror((m) => messageRow(m, FAKE_MARKED.alice, 1))?.kept === 1)
  })

  test("do not touch a message with no timer", async () => {
    await fixture.running()
    fixture.client.onNewMessage.emit(aliceMessage(1))

    fixture.clock.advance(90_000)
    await eventually(() => fixture.meta().alive_at === String(START_MS + 90_000))

    expect(fixture.mirror((m) => messageRow(m, FAKE_MARKED.alice, 1))).toBeDefined()
  })
})

describe("the purge", () => {
  test("at the start forgets tombstones past their fence and keeps the others", async () => {
    fixture.seed((mirror) => {
      recordDeleted(mirror, null, 7, START_MS - TOMBSTONE_TTL_MS - 1)
      recordDeleted(mirror, null, 8, START_MS)
    })

    await fixture.running()

    expect(fixture.mirror((m) => rowsOf(m, "SELECT id FROM deleted"))).toEqual([{ id: 8 }])
  })

  test("runs again once its interval has passed on the clock", async () => {
    await fixture.running({ purgeEveryMs: 1_000 })
    fixture.seed((mirror) => recordDeleted(mirror, null, 7, START_MS - TOMBSTONE_TTL_MS - 1))

    fixture.clock.advance(1_000)

    await eventually(() => fixture.mirror((m) => rowsOf(m, "SELECT id FROM deleted")).length === 0)
  })
})
