import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { getMeta, setMeta } from "./mirror"
import { META, SYNC_STATUS, readStatus, recordStatus } from "./mirror-meta"
import { NOW, createTestMirror, type TestMirror } from "./mirror.testing"

let t: TestMirror

beforeEach(() => {
  t = createTestMirror()
})

afterEach(() => t.close())

describe("META and SYNC_STATUS", () => {
  test("hold the keys and values the mirror stores", () => {
    const keys: string[] = Object.values(META)
    expect(keys.sort()).toEqual([
      "account_id",
      "account_name",
      "alive_at",
      "connected_at",
      "error",
      "last_received_at",
      "refreshed_at",
      "started_at",
      "status",
    ])
    expect(Object.values(SYNC_STATUS)).toEqual(["starting", "running", "stopped", "logged out", "failed"])
  })
})

describe("recordStatus and readStatus", () => {
  test("nothing is recorded in a new mirror", () => {
    expect(readStatus(t.mirror)).toBeUndefined()
  })

  test("starting records the status and when it started", () => {
    recordStatus(t.mirror, SYNC_STATUS.starting, null, NOW)

    expect(readStatus(t.mirror)).toEqual({ status: "starting" })
    expect(getMeta(t.mirror)[META.startedAt]).toBe(String(NOW))
  })

  test("a failure records its error, and a later status clears it", () => {
    recordStatus(t.mirror, SYNC_STATUS.failed, "connection lost", NOW)
    expect(readStatus(t.mirror)).toEqual({ status: "failed", error: "connection lost" })

    recordStatus(t.mirror, SYNC_STATUS.running, null, NOW + 1)
    expect(readStatus(t.mirror)).toEqual({ status: "running" })
  })

  test("other statuses leave started_at alone", () => {
    recordStatus(t.mirror, SYNC_STATUS.starting, null, NOW)
    recordStatus(t.mirror, SYNC_STATUS.stopped, null, NOW + 5)

    expect(getMeta(t.mirror)[META.startedAt]).toBe(String(NOW))
    expect(readStatus(t.mirror)).toEqual({ status: "stopped" })
  })

  test("a value that is not a known status reads as none", () => {
    setMeta(t.mirror, { [META.status]: "unlinked" })

    expect(readStatus(t.mirror)).toBeUndefined()
  })
})
