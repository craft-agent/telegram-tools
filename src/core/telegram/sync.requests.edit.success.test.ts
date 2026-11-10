import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { fakeMessage, fakeUser, messageOf } from "./fake-telegram.testing"
import { messageRow, rowsOf } from "./mirror.testing"
import { answered } from "./sync-client-send.testing"
import { FORUM, KEPT } from "./sync-requests.testing"
import {
  EDIT_DATE,
  EDIT_MS,
  NEW_TEXT,
  OWN,
  OWN_IN_FORUM,
  OWN_TEXT,
  actionsOf,
  edit,
  editedInForum,
  editedInPrivate,
  seedActionChats,
} from "./sync-action.testing"
import { START_MS, syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeEach(async () => {
  fixture = syncFixture()
  seedActionChats(fixture)
  await fixture.running()
  fixture.client.setActionAnswer(editedInPrivate(OWN.text, NEW_TEXT))
})

afterEach(() => fixture.close())

const row = (chat: string, id: number) => fixture.mirror((mirror) => messageRow(mirror, chat, id))
const earlier = (chat: string, id: number) =>
  fixture.mirror((mirror) =>
    rowsOf(mirror, "SELECT seq, at, body FROM edits WHERE chat = ? AND id = ? ORDER BY seq", chat, id),
  )

describe("an edit Telegram accepts", () => {
  test("answers with the id and the time of the edit, after one call with retries and sleeps off", async () => {
    expect(await edit(fixture, { chat: KEPT, id: OWN.text, text: NEW_TEXT })).toEqual({ id: OWN.text, edited: EDIT_MS })

    const [only, ...rest] = actionsOf(fixture)
    expect(rest).toEqual([])
    expect(only?.options).toMatchObject({ maxRetryCount: 0, floodSleepThreshold: 0 })
    expect(only?.options.abortSignal).toBeInstanceOf(AbortSignal)
    expect(only?.request).toEqual({
      _: "messages.editMessage",
      peer: { _: "inputPeerUser", userId: Number(KEPT), accessHash: expect.anything() },
      id: OWN.text,
      message: NEW_TEXT,
    })
  })

  test("is recorded in the mirror, with the version it replaced in the earlier versions", async () => {
    await edit(fixture, { chat: KEPT, id: OWN.text, text: NEW_TEXT })

    expect(row(KEPT, OWN.text)).toMatchObject({ body: NEW_TEXT, edited: EDIT_MS, from_me: 1 })
    expect(earlier(KEPT, OWN.text)).toEqual([{ seq: 1, at: START_MS - 10_000, body: OWN_TEXT }])
  })

  test("keeps every earlier version of a message edited again", async () => {
    await edit(fixture, { chat: KEPT, id: OWN.text, text: NEW_TEXT })
    fixture.client.setActionAnswer({
      ...editedInPrivate(OWN.text, "third"),
      updates: [
        {
          _: "updateEditMessage",
          message: fakeMessage({
            id: OWN.text,
            out: true,
            fromId: undefined,
            message: "third",
            editDate: EDIT_DATE + 60,
          }),
          pts: 52,
          ptsCount: 1,
        },
      ],
    })

    await edit(fixture, { chat: KEPT, id: OWN.text, text: "third" })

    expect(earlier(KEPT, OWN.text).map((version) => version.body)).toEqual([OWN_TEXT, NEW_TEXT])
    expect(row(KEPT, OWN.text)).toMatchObject({ body: "third", edited: EDIT_MS + 60_000 })
  })

  test("in a supergroup goes to its channel and is recorded there", async () => {
    fixture.client.setActionAnswer(editedInForum(OWN_IN_FORUM, NEW_TEXT))

    expect(await edit(fixture, { chat: FORUM, id: OWN_IN_FORUM, text: NEW_TEXT })).toEqual({
      id: OWN_IN_FORUM,
      edited: EDIT_MS,
    })

    expect(actionsOf(fixture)[0]?.request).toMatchObject({
      peer: { _: "inputPeerChannel" },
      id: OWN_IN_FORUM,
      message: NEW_TEXT,
    })
    expect(row(FORUM, OWN_IN_FORUM)).toMatchObject({ body: NEW_TEXT, edited: EDIT_MS })
    expect(earlier(FORUM, OWN_IN_FORUM)).toHaveLength(1)
  })

  test("sets a photo's caption without a request of its own", async () => {
    fixture.client.setActionAnswer(editedInPrivate(OWN.photo, NEW_TEXT))

    await edit(fixture, { chat: KEPT, id: OWN.photo, text: NEW_TEXT })

    expect(row(KEPT, OWN.photo)).toMatchObject({ body: NEW_TEXT })
    expect(actionsOf(fixture)[0]?.request).toMatchObject({ _: "messages.editMessage", message: NEW_TEXT })
  })

  test("tells mtcute's update state, which dispatches nothing", async () => {
    await edit(fixture, { chat: KEPT, id: OWN.text, text: NEW_TEXT })

    expect(fixture.client.handled).toHaveLength(1)
    expect(fixture.client.handled[0]).toMatchObject({ update: { _: "updates" }, noDispatch: true })
  })

  test("is not a second version when the same edit comes as an update afterwards", async () => {
    await edit(fixture, { chat: KEPT, id: OWN.text, text: NEW_TEXT })

    const echo = fakeMessage({ id: OWN.text, out: true, fromId: undefined, message: NEW_TEXT, editDate: EDIT_DATE })
    fixture.client.onEditMessage.emit(messageOf(echo, fakeUser()))

    expect(earlier(KEPT, OWN.text)).toHaveLength(1)
  })
})

describe("an edit Telegram answers that the message already has the text", () => {
  test("is done, with no time while the mirror does not have the text", async () => {
    fixture.client.setActionAnswer(answered(400, "MESSAGE_NOT_MODIFIED"))

    expect(await edit(fixture, { chat: KEPT, id: OWN.text, text: NEW_TEXT })).toEqual({ id: OWN.text, already: true })

    expect(actionsOf(fixture)).toHaveLength(1)
    expect(row(KEPT, OWN.text)).toMatchObject({ body: OWN_TEXT, edited: null })
  })

  test("gives the time of the edit when an update of the earlier delivery came first", async () => {
    fixture.client.setActionAnswer(() => {
      const echo = fakeMessage({ id: OWN.text, out: true, fromId: undefined, message: NEW_TEXT, editDate: EDIT_DATE })
      fixture.client.onEditMessage.emit(messageOf(echo, fakeUser()))
      return answered(400, "MESSAGE_NOT_MODIFIED")
    })

    expect(await edit(fixture, { chat: KEPT, id: OWN.text, text: NEW_TEXT })).toEqual({
      id: OWN.text,
      edited: EDIT_MS,
      already: true,
    })
  })

  test("is done also when the connection came back during the call", async () => {
    fixture.client.setActionAnswer(() => {
      fixture.client.drop()
      fixture.client.regain()
      return answered(400, "MESSAGE_NOT_MODIFIED")
    })

    expect(await edit(fixture, { chat: KEPT, id: OWN.text, text: NEW_TEXT })).toMatchObject({
      id: OWN.text,
      already: true,
    })
  })
})
