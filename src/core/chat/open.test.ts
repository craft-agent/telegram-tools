import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { labelPaths } from "../telegram/labels"
import { USER } from "../telegram/mirror.testing"
import { pickPaths, readMirror } from "./open"
import { createChatFixture, type ChatFixture } from "./read.testing"

let t: ChatFixture

beforeEach(() => {
  t = createChatFixture()
  t.follow({ id: USER })
  t.store({ id: 1 })
})

afterEach(() => {
  t.close()
})

const count = (mirror: { prepare(sql: string): { get(): unknown } }) =>
  (mirror.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n

describe("pickPaths", () => {
  test("gives the label's paths for the account", async () => {
    const paths = await pickPaths({ stateDir: t.stateDir }, undefined)
    expect(paths).toEqual(labelPaths(t.stateDir, "default"))
  })

  test("throws internal_error when state directory is missing", async () => {
    await expect(pickPaths({}, undefined)).rejects.toMatchObject({
      code: "internal_error",
      message: "The entry point did not supply a state directory.",
    })
  })
})

describe("readMirror", () => {
  test("runs read in a read transaction and closes the mirror afterwards", async () => {
    const paths = await pickPaths({ stateDir: t.stateDir }, undefined)
    let seen: { prepare(sql: string): unknown } | undefined
    readMirror(paths, (mirror) => {
      seen = mirror
    })
    expect(() => seen?.prepare("SELECT 1")).toThrow()
  })

  test("everything one call reads belongs to one moment, whatever the service writes meanwhile", async () => {
    const paths = await pickPaths({ stateDir: t.stateDir }, undefined)
    const counts = readMirror(paths, (mirror) => {
      const before = count(mirror)
      t.store({ id: 2 }, { id: 3 })
      return [before, count(mirror), mirror.isTransaction]
    })
    expect(counts).toEqual([1, 1, true])
    expect(readMirror(paths, count)).toBe(3)
  })

  test("closes the mirror, snapshot and all, also when the read throws, so the writer is never held up", async () => {
    const paths = await pickPaths({ stateDir: t.stateDir }, undefined)
    expect(() =>
      readMirror(paths, () => {
        throw new Error("boom")
      }),
    ).toThrow("boom")
    t.store({ id: 2 })
    t.mirror.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    expect(readMirror(paths, count)).toBe(2)
  })

  test("refuses every write", async () => {
    const paths = await pickPaths({ stateDir: t.stateDir }, undefined)
    expect(() => readMirror(paths, (mirror) => mirror.exec("DELETE FROM messages"))).toThrow()
    expect(readMirror(paths, count)).toBe(1)
  })
})
