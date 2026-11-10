import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { FAKE_IDS } from "./fake-telegram.testing"
import { messageRow, rowsOf } from "./mirror.testing"
import { FORUM, KEPT } from "./sync-requests.testing"
import {
  NEW_TEXT,
  OWN,
  OWN_IN_FORUM,
  actionsOf,
  affected,
  edit,
  editedInPrivate,
  remove,
  seedActionChats,
} from "./sync-action.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeEach(async () => {
  fixture = syncFixture()
  seedActionChats(fixture)
  await fixture.running()
  fixture.client.setActionAnswer(affected())
})

afterEach(() => fixture.close())

const row = (chat: string, id: number) => fixture.mirror((mirror) => messageRow(mirror, chat, id))
const tombstones = (id: number) =>
  fixture.mirror((mirror) => rowsOf(mirror, "SELECT chat FROM deleted WHERE id = ?", id).map((found) => found.chat))
const earlier = (chat: string, id: number) =>
  fixture.mirror((mirror) => rowsOf(mirror, "SELECT 1 FROM edits WHERE chat = ? AND id = ?", chat, id).length)

describe("a delete in a private chat", () => {
  test("is one call that deletes for everyone, with retries and sleeps off", async () => {
    expect(await remove(fixture, { chat: KEPT, id: OWN.text })).toEqual({ id: OWN.text, deleted: true })

    const [only, ...rest] = actionsOf(fixture)
    expect(rest).toEqual([])
    expect(only?.options).toMatchObject({ maxRetryCount: 0, floodSleepThreshold: 0 })
    expect(only?.options.abortSignal).toBeInstanceOf(AbortSignal)
    expect(only?.request).toEqual({ _: "messages.deleteMessages", revoke: true, id: [OWN.text] })
  })

  test("removes the message with its earlier versions, and leaves a tombstone for no chat in particular", async () => {
    fixture.client.setActionAnswer(editedInPrivate(OWN.text, NEW_TEXT))
    await edit(fixture, { chat: KEPT, id: OWN.text, text: NEW_TEXT })
    expect(earlier(KEPT, OWN.text)).toBe(1)
    fixture.client.setActionAnswer(affected())

    await remove(fixture, { chat: KEPT, id: OWN.text })

    expect(row(KEPT, OWN.text)).toBeUndefined()
    expect(earlier(KEPT, OWN.text)).toBe(0)
    expect(tombstones(OWN.text)).toEqual([null])
  })

  test("leaves the other messages alone", async () => {
    await remove(fixture, { chat: KEPT, id: OWN.text })

    expect(row(KEPT, OWN.photo)).toBeDefined()
    expect(row(KEPT, 1)).toBeDefined()
  })

  test("tells mtcute's update state of the count, with a dummy update for the account's own state", async () => {
    fixture.client.setActionAnswer(affected(1, 61))

    await remove(fixture, { chat: KEPT, id: OWN.text })

    expect(fixture.client.handled).toEqual([
      {
        update: {
          _: "updates",
          seq: 0,
          date: 0,
          chats: [],
          users: [],
          updates: [{ _: "mtcute.dummyUpdate", channelId: 0, pts: 61, ptsCount: 1 }],
        },
        noDispatch: undefined,
      },
    ])
  })
})

describe("a delete in a supergroup", () => {
  test("goes to its channel's own method", async () => {
    expect(await remove(fixture, { chat: FORUM, id: OWN_IN_FORUM })).toEqual({ id: OWN_IN_FORUM, deleted: true })

    expect(actionsOf(fixture).map(({ request }) => request)).toEqual([
      {
        _: "channels.deleteMessages",
        channel: { _: "inputChannel", channelId: FAKE_IDS.supergroup, accessHash: expect.anything() },
        id: [OWN_IN_FORUM],
      },
    ])
  })

  test("removes the message and leaves a tombstone for that chat", async () => {
    await remove(fixture, { chat: FORUM, id: OWN_IN_FORUM })

    expect(row(FORUM, OWN_IN_FORUM)).toBeUndefined()
    expect(tombstones(OWN_IN_FORUM)).toEqual([FORUM])
  })

  test("tells mtcute's update state of the channel's count", async () => {
    fixture.client.setActionAnswer(affected(1, 62))

    await remove(fixture, { chat: FORUM, id: OWN_IN_FORUM })

    expect(fixture.client.handled[0]?.update).toMatchObject({
      updates: [{ _: "mtcute.dummyUpdate", channelId: FAKE_IDS.supergroup, pts: 62, ptsCount: 1 }],
    })
  })
})

describe("a delete Telegram counts no message for", () => {
  test("is done, says it was done already, and clears the mirror", async () => {
    fixture.client.setActionAnswer(affected(0))

    expect(await remove(fixture, { chat: KEPT, id: OWN.text })).toEqual({ id: OWN.text, deleted: true, already: true })

    expect(actionsOf(fixture)).toHaveLength(1)
    expect(row(KEPT, OWN.text)).toBeUndefined()
  })
})
