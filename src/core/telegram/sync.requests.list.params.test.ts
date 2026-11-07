import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { failureOf } from "./service.testing"
import { SUPERGROUP_ID, SECOND_ID, followedOf, syncListOf } from "./sync-list.testing"
import { request, seedListedChats } from "./sync-requests.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeAll(async () => {
  fixture = syncFixture()
  seedListedChats(fixture)
  await fixture.running()
})

afterAll(() => fixture.close())

const ok = { chats: [SUPERGROUP_ID, SECOND_ID] }
const ids = (count: number) =>
  Array.from({ length: count }, (_, index) => `-100400000${String(index).padStart(4, "0")}`)

const bad: [string, unknown][] = [
  ["no parameters", undefined],
  ["a list", [SUPERGROUP_ID]],
  ["no chats", {}],
  ["chats that are text", { chats: SUPERGROUP_ID }],
  ["null chats", { chats: null }],
  ["an empty list", { chats: [] }],
  ["more chats than the list holds", { chats: ids(31) }],
  ["a chat that is a number", { chats: [1001] }],
  ["a null chat", { chats: [SUPERGROUP_ID, null] }],
  ["an empty chat", { chats: [SUPERGROUP_ID, ""] }],
  ["a chat named twice", { chats: [SUPERGROUP_ID, SECOND_ID, SUPERGROUP_ID] }],
  ["a field it does not take", { ...ok, force: true }],
  ["a field named __proto__", Object.fromEntries([...Object.entries(ok), ["__proto__", 1]])],
  ["a chat as well as chats", { ...ok, chat: SUPERGROUP_ID }],
]

for (const method of ["sync_add", "sync_remove"] as const) {
  describe(`${method} parameters`, () => {
    for (const [name, params] of bad) {
      test(`refuses ${name}`, async () => {
        expect(await failureOf(request(fixture, method, params as Record<string, unknown>))).toMatchObject({
          code: "invalid_argument",
        })
        expect(syncListOf(fixture)).toEqual([])
        expect(followedOf(fixture, SUPERGROUP_ID)).toBe(0)
      })
    }
  })
}
