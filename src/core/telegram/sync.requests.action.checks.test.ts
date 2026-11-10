import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { CAPTION_MAX_UNITS } from "./service-requests"
import { CHANNEL } from "./mirror.testing"
import { failureOf } from "./service.testing"
import { KEPT, PLAIN, UNLISTED } from "./sync-requests.testing"
import { LEFT_GROUP } from "./sync-send.testing"
import {
  NEW_TEXT,
  OWN,
  OWN_TEXT,
  THEIRS,
  actionsOf,
  edit,
  editedInPrivate,
  remove,
  seedActionChats,
} from "./sync-action.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeAll(async () => {
  fixture = syncFixture()
  seedActionChats(fixture)
  await fixture.running()
})

afterAll(() => fixture.close())

beforeEach(() => {
  fixture.client.calls.length = 0
  fixture.client.setActionAnswer(editedInPrivate(OWN.text, NEW_TEXT))
})

const refusedEdit = (params: Record<string, unknown>) =>
  failureOf(edit(fixture, { chat: KEPT, id: OWN.text, text: NEW_TEXT, ...params }))
const refusedDelete = (params: Record<string, unknown>) =>
  failureOf(remove(fixture, { chat: KEPT, id: OWN.text, ...params }))

/** A refusal before the call leaves no trace at Telegram: the peer is not even resolved. */
const nothingAsked = () => {
  expect(actionsOf(fixture)).toEqual([])
  expect(fixture.client.argsOf("resolvePeer")).toEqual([])
}

describe("an edit the mirror shows cannot succeed", () => {
  test("in a chat it does not list is not found", async () => {
    expect(await refusedEdit({ chat: UNLISTED })).toMatchObject({ code: "not_found" })
    nothingAsked()
  })

  test("in a channel is not found while channels are off", async () => {
    expect(await refusedEdit({ chat: CHANNEL })).toMatchObject({ code: "not_found" })
    nothingAsked()
  })

  test("in a chat the account left is forbidden, and the answer says nothing was edited", async () => {
    expect(await refusedEdit({ chat: LEFT_GROUP })).toMatchObject({
      code: "forbidden",
      message: "You are no longer in this chat; nothing was edited.",
    })
    nothingAsked()
  })

  test("of a message someone else wrote is forbidden", async () => {
    expect(await refusedEdit({ id: THEIRS })).toMatchObject({
      code: "forbidden",
      message: "Only your own messages can be edited.",
    })
    nothingAsked()
  })

  test("of a message the mirror lacks is not found", async () => {
    expect(await refusedEdit({ id: 77 })).toMatchObject({
      code: "not_found",
      message: "No message 77 in this chat; nothing was edited.",
    })
    nothingAsked()
  })

  test("of a message in a chat the mirror does not keep is not found, since it holds no messages to check", async () => {
    expect(await refusedEdit({ chat: PLAIN })).toMatchObject({ code: "not_found" })
    nothingAsked()
  })

  test("of a message deleted for everyone is not found", async () => {
    expect(await refusedEdit({ id: OWN.deleted })).toMatchObject({ code: "not_found" })
    nothingAsked()
  })

  test("to the text the message has is invalid, with nothing to edit", async () => {
    expect(await refusedEdit({ text: OWN_TEXT })).toMatchObject({
      code: "invalid_argument",
      message: "The text is the same as the message's; nothing to edit.",
    })
    nothingAsked()
  })

  test("of a service message is invalid, since it has neither a text nor a caption", async () => {
    expect(await refusedEdit({ id: OWN.service })).toMatchObject({ code: "invalid_argument" })
    nothingAsked()
  })

  test("of a photo's caption over the caption limit is invalid", async () => {
    expect(await refusedEdit({ id: OWN.photo, text: "c".repeat(CAPTION_MAX_UNITS + 1) })).toMatchObject({
      code: "invalid_argument",
    })
    nothingAsked()
  })
})

describe("an edit that is allowed", () => {
  test("gives a photo a caption of exactly the caption limit, also when it has none yet", async () => {
    const text = "c".repeat(CAPTION_MAX_UNITS)
    fixture.client.setActionAnswer(editedInPrivate(OWN.bare, text))

    expect(await edit(fixture, { chat: KEPT, id: OWN.bare, text })).toMatchObject({ id: OWN.bare })
    expect(actionsOf(fixture)).toHaveLength(1)
  })

  test("gives a text with a link preview more than the caption limit, since the preview is no media", async () => {
    const text = "t".repeat(CAPTION_MAX_UNITS + 1)
    fixture.client.setActionAnswer(editedInPrivate(OWN.preview, text))

    expect(await edit(fixture, { chat: KEPT, id: OWN.preview, text })).toMatchObject({ id: OWN.preview })
    expect(actionsOf(fixture)).toHaveLength(1)
  })
})

describe("a delete the mirror shows cannot succeed", () => {
  test("in a chat it does not list is not found", async () => {
    expect(await refusedDelete({ chat: UNLISTED })).toMatchObject({ code: "not_found" })
    nothingAsked()
  })

  test("in a chat the account left is forbidden, and the answer says nothing was deleted", async () => {
    expect(await refusedDelete({ chat: LEFT_GROUP })).toMatchObject({
      code: "forbidden",
      message: "You are no longer in this chat; nothing was deleted.",
    })
    nothingAsked()
  })

  test("of a message someone else wrote is forbidden", async () => {
    expect(await refusedDelete({ id: THEIRS })).toMatchObject({
      code: "forbidden",
      message: "Only your own messages can be deleted.",
    })
    nothingAsked()
  })

  test("of a message the mirror lacks is not found", async () => {
    expect(await refusedDelete({ id: 77 })).toMatchObject({ code: "not_found" })
    nothingAsked()
  })
})

describe("a delete of a message the mirror has as deleted", () => {
  test("is done without a call, and says it was done already", async () => {
    expect(await remove(fixture, { chat: KEPT, id: OWN.deleted })).toEqual({
      id: OWN.deleted,
      deleted: true,
      already: true,
    })
    nothingAsked()
  })
})
