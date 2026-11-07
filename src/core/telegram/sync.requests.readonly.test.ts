import { afterEach, beforeEach, expect, test } from "bun:test"
import { openMirrorForRead, type Mirror } from "./mirror"
import { rowsOf } from "./mirror.testing"
import { FORUM, forumTopic, groupMessage, request, seedListedChats } from "./sync-requests.testing"
import { eventually, syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture
let reader: Mirror

/** Timings that leave the service nothing to write once it has started. */
const QUIET = { heartbeatEveryMs: 1_000_000, roundEveryMs: 1_000_000 }

beforeEach(async () => {
  fixture = syncFixture()
  seedListedChats(fixture)
  fixture.client.setHistory(FORUM, groupMessage(2), groupMessage(1))
  fixture.client.setThread(FORUM, 7, groupMessage(2))
  fixture.client.setTopics(FORUM, forumTopic(7))
  await fixture.running(QUIET)
  await eventually(() => fixture.logs.includes("refreshed 0 chats, filled 0 messages") && "alive_at" in fixture.meta())
  reader = openMirrorForRead(fixture.paths.mirror)
})

afterEach(async () => {
  reader.close()
  await fixture.close()
})

/** Every row of every table, as text, to compare before and after. */
function contents(): string {
  const tables = rowsOf(reader, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
  return JSON.stringify(tables.map(({ name }) => rowsOf(reader, `SELECT * FROM "${name}"`)))
}

const dataVersion = () => rowsOf(reader, "PRAGMA data_version")[0]

test("reading a chat or its topics live writes nothing to the mirror and marks nothing read", async () => {
  const before = { contents: contents(), version: dataVersion() }
  const callsBefore = fixture.client.calls.length

  await request(fixture, "history", { chat: FORUM, limit: 10 })
  await request(fixture, "history", { chat: FORUM, limit: 10, topic: 7 })
  await request(fixture, "topics", { chat: FORUM, limit: 10 })

  expect({ contents: contents(), version: dataVersion() }).toEqual(before)
  expect(fixture.client.calls.slice(callsBefore).map((call) => call.method)).toEqual([
    "getHistory",
    "searchMessages",
    "getForumTopics",
  ])
})
