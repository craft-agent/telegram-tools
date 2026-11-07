import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { FAKE_DATE } from "./fake-telegram.testing"
import type { TopicsResult } from "./service-requests"
import { FORUM, forumTopic, request, seedListedChats } from "./sync-requests.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeEach(async () => {
  fixture = syncFixture()
  seedListedChats(fixture)
  await fixture.running()
})

afterEach(() => fixture.close())

const chatId = Number(FORUM)
const list = (params: Record<string, unknown> = {}) =>
  request<TopicsResult>(fixture, "topics", { chat: FORUM, limit: 10, ...params })

describe("the topics of a forum supergroup", () => {
  test("come as Telegram lists them, mapped to what a tool shows", async () => {
    fixture.client.setTopics(
      FORUM,
      forumTopic(5, { unreadCount: 3, pinned: true }),
      forumTopic(6, { closed: true }),
      forumTopic(1, { title: "General" }),
    )

    const { topics } = await list()

    expect(fixture.client.argsOf("getForumTopics")).toEqual([{ chat: chatId, limit: 10 }])
    expect(topics).toEqual([
      { id: 5, title: "Topic 5", closed: false, pinned: true, unread: 3, last_ts: (FAKE_DATE + 5) * 1000 },
      { id: 6, title: "Topic 6", closed: true, pinned: false, unread: 0, last_ts: (FAKE_DATE + 6) * 1000 },
      { id: 1, title: "General", closed: false, pinned: false, unread: 0, last_ts: (FAKE_DATE + 1) * 1000 },
    ])
  })

  test("have no title while Telegram says it is missing, and no time when the newest message did not come", async () => {
    fixture.client.setTopics(FORUM, forumTopic(8, { titleMissing: true, title: "" }, false))

    expect((await list()).topics).toEqual([
      { id: 8, title: null, closed: false, pinned: false, unread: 0, last_ts: null },
    ])
  })

  test("are paged by the offset Telegram gave, which is passed back as it came", async () => {
    fixture.client.setTopics(FORUM, forumTopic(5), forumTopic(6), forumTopic(7))

    const first = await list({ limit: 2 })
    const second = await list({ limit: 2, offset: first.next })

    expect(first.topics.map((topic) => topic.id)).toEqual([5, 6])
    expect(first.next).toEqual({ date: FAKE_DATE + 6, id: 106, topic: 6 })
    expect(second.topics.map((topic) => topic.id)).toEqual([7])
    expect(second).not.toHaveProperty("next")
    expect(fixture.client.argsOf("getForumTopics")).toEqual([
      { chat: chatId, limit: 2 },
      { chat: chatId, limit: 2, offset: { date: FAKE_DATE + 6, id: 106, topic: 6 } },
    ])
  })

  test("end with a page that has no `next`", async () => {
    expect(await list()).toEqual({ topics: [] })
  })
})
