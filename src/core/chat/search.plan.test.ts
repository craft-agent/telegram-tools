import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestMirror, rowsOf, type TestMirror } from "../telegram/mirror.testing"
import { rangeConditions } from "./range"
import { SCAN_LIMITS, chunkStatement, type ScanScope } from "./search"

let t: TestMirror

beforeEach(() => {
  t = createTestMirror()
})

afterEach(() => {
  t.close()
})

/** What SQLite says it will do for a chunk of the scan, one line per step. */
function plan(scope: ScanScope, after?: { ts: number; chat: string; id: number }): string {
  const { sql, params } = chunkStatement(scope, after)
  const rows = rowsOf(t.mirror, `EXPLAIN QUERY PLAN ${sql}`, ...params, SCAN_LIMITS.chunk + 1)
  return rows.map((row) => String(row.detail)).join("\n")
}

const everyChat: ScanScope = { conditions: ["kind = 'message'"], params: [] }
const somewhere = { ts: 5000, chat: "1", id: 7 }

describe("the scan of a search across every chat", () => {
  test("is served in order by the time index, with no sort", () => {
    const steps = plan(everyChat)
    expect(steps).toContain("messages_time")
    expect(steps).not.toContain("TEMP B-TREE")
  })

  test("seeks to where the last chunk ended instead of reading the history before it", () => {
    expect(plan(everyChat, somewhere)).toMatch(/^SEARCH messages USING INDEX messages_time \(\(ts,\s*chat,\s*id\)</)
  })

  test("one chat is served from an index too, never by sorting its whole history", () => {
    const steps = plan({ conditions: ["kind = 'message'", "chat = ?"], params: ["1"] }, somewhere)
    expect(steps).toContain("USING INDEX messages_ts (chat=?")
    expect(steps).not.toMatch(/FOR ORDER BY/)
  })

  test("keeps to the index with a range of times", () => {
    const bounds = rangeConditions({ after: 1000, before: 9000 })
    const steps = plan({ conditions: ["kind = 'message'", ...bounds.conditions], params: bounds.params }, somewhere)
    expect(steps).toContain("messages_time")
    expect(steps).not.toContain("TEMP B-TREE")
  })
})
