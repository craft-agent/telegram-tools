import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { excludingContext } from "../chat/excluded.testing"
import { at } from "../chat/read.testing"
import { CHANNEL, SUPERGROUP } from "../telegram/mirror.testing"
import { invoke } from "../tool"
import { telegramSyncRead } from "./read"
import { createSyncFixture, SUPERGROUP_B, type SyncFixture } from "./sync.testing"

let t: SyncFixture

beforeEach(() => {
  t = createSyncFixture()
})

afterEach(async () => {
  await t.stopServices()
  t.close()
})

const listWithout = (excluded: string[]) =>
  invoke(telegramSyncRead, { method: "list" }, excludingContext(t.stateDir, excluded))

describe("sync read: excluded chats", () => {
  test("an excluded chat is left off the list, and size still counts it", async () => {
    t.listed({ id: SUPERGROUP, name: "Old Friends" }, at(1))
    t.listed({ id: CHANNEL, kind: "channel", name: "News" }, at(2))
    const result = await listWithout([SUPERGROUP])
    expect(result.chats.map((chat) => chat.id)).toEqual([CHANNEL])
    expect(result.size).toBe(2)
    expect(JSON.stringify(result)).not.toContain("Old Friends")
  })

  test("a listed chat the mirror has no row for is left off by the id on the list", async () => {
    t.listed({ id: SUPERGROUP }, at(1))
    t.mirror.prepare("INSERT INTO sync_list (chat, added, seeded) VALUES (?, ?, NULL)").run(SUPERGROUP_B, at(2))
    const result = await listWithout([SUPERGROUP_B])
    expect(result.chats.map((chat) => chat.id)).toEqual([SUPERGROUP])
    expect(result.size).toBe(2)
  })

  test("with no chat excluded the list is whole", async () => {
    t.listed({ id: SUPERGROUP }, at(1))
    expect((await listWithout([])).chats.map((chat) => chat.id)).toEqual([SUPERGROUP])
  })
})
