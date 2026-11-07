import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { labelPaths } from "../telegram/labels"
import { USER } from "../telegram/mirror.testing"
import { withMirror } from "./open"
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

describe("withMirror", () => {
  test("gives the label's paths and closes the mirror afterwards", async () => {
    let seen: { prepare(sql: string): unknown } | undefined
    const paths = await withMirror({ stateDir: t.stateDir }, undefined, (mirror, labelled) => {
      seen = mirror
      return labelled
    })
    expect(paths).toEqual(labelPaths(t.stateDir, "default"))
    expect(() => seen?.prepare("SELECT 1")).toThrow()
  })

  test("everything one call reads belongs to one moment, whatever the service writes meanwhile", async () => {
    const counts = await withMirror({ stateDir: t.stateDir }, undefined, (mirror) => {
      const before = count(mirror)
      t.store({ id: 2 }, { id: 3 })
      return [before, count(mirror), mirror.isTransaction]
    })
    expect(counts).toEqual([1, 1, true])
    expect(await withMirror({ stateDir: t.stateDir }, undefined, count)).toBe(3)
  })

  test("closes the mirror, snapshot and all, also when the read throws, so the writer is never held up", async () => {
    await expect(
      withMirror({ stateDir: t.stateDir }, undefined, () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    t.store({ id: 2 })
    t.mirror.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    expect(await withMirror({ stateDir: t.stateDir }, undefined, count)).toBe(2)
  })

  test("refuses every write", async () => {
    await expect(
      withMirror({ stateDir: t.stateDir }, undefined, (mirror) => mirror.exec("DELETE FROM messages")),
    ).rejects.toThrow()
    expect(await withMirror({ stateDir: t.stateDir }, undefined, count)).toBe(1)
  })
})
