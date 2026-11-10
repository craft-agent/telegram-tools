import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { messageRow, rowsOf } from "./mirror.testing"
import { answered } from "./sync-client-send.testing"
import { FORUM, KEPT } from "./sync-requests.testing"
import { OWN, OWN_IN_FORUM, THEIRS, actionsOf, updatesGroup } from "./sync-action.testing"
import {
  BOT_CHAT,
  IN_OTHER_CHAT,
  PIN_DATE,
  PIN_SERVICE_ID,
  SAVED,
  pin,
  pinnedAnswer,
  seedPinChats,
} from "./sync-pin.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeEach(async () => {
  fixture = syncFixture()
  seedPinChats(fixture)
  await fixture.running()
  fixture.client.setActionAnswer(pinnedAnswer(THEIRS))
})

afterEach(() => fixture.close())

const request = () => actionsOf(fixture)[0]?.request
const user = { _: "inputPeerUser" as const, userId: Number(KEPT), accessHash: expect.anything() }
const row = (chat: string, id: number) => fixture.mirror((mirror) => messageRow(mirror, chat, id))
const messageIds = (chat: string) =>
  fixture
    .mirror((mirror) => rowsOf(mirror, "SELECT id FROM messages WHERE chat = ? ORDER BY id", chat))
    .map((r) => r.id)

describe("a pin Telegram accepts", () => {
  test("is silent and one-sided in a private chat by default, in one call with retries and sleeps off", async () => {
    expect(await pin(fixture, { chat: KEPT, id: THEIRS })).toEqual({ id: THEIRS, pinned: true })

    const [only, ...rest] = actionsOf(fixture)
    expect(rest).toEqual([])
    expect(only?.options).toMatchObject({ maxRetryCount: 0, floodSleepThreshold: 0 })
    expect(only?.options.abortSignal).toBeInstanceOf(AbortSignal)
    expect(only?.request).toEqual({
      _: "messages.updatePinnedMessage",
      peer: user,
      id: THEIRS,
      silent: true,
      pmOneside: true,
    })
  })

  test("with both sides leaves out the one-sided flag", async () => {
    await pin(fixture, { chat: KEPT, id: THEIRS, both_sides: true })

    expect(request()).toEqual({ _: "messages.updatePinnedMessage", peer: user, id: THEIRS, silent: true })
  })

  test("with notify leaves out the silent flag", async () => {
    await pin(fixture, { chat: KEPT, id: THEIRS, notify: true })

    expect(request()).toEqual({ _: "messages.updatePinnedMessage", peer: user, id: THEIRS, pmOneside: true })
  })

  test("with notify and both sides carries no flag at all", async () => {
    await pin(fixture, { chat: KEPT, id: THEIRS, notify: true, both_sides: true })

    expect(request()).toEqual({ _: "messages.updatePinnedMessage", peer: user, id: THEIRS })
  })

  test("is one-sided in a chat with a bot by default, as with a person", async () => {
    await pin(fixture, { chat: BOT_CHAT, id: IN_OTHER_CHAT })

    expect(request()).toMatchObject({ silent: true, pmOneside: true })
  })

  test("sets no one-sided flag in Saved Messages, which has no other side", async () => {
    await pin(fixture, { chat: SAVED, id: IN_OTHER_CHAT })

    expect(request()).toEqual({
      _: "messages.updatePinnedMessage",
      peer: expect.objectContaining({ _: "inputPeerUser" }),
      id: IN_OTHER_CHAT,
      silent: true,
    })
  })

  test("in a supergroup goes to its channel, silent, with no one-sided flag", async () => {
    fixture.client.setActionAnswer(pinnedAnswer(OWN_IN_FORUM, { forum: true }))

    expect(await pin(fixture, { chat: FORUM, id: OWN_IN_FORUM })).toEqual({ id: OWN_IN_FORUM, pinned: true })

    expect(request()).toEqual({
      _: "messages.updatePinnedMessage",
      peer: expect.objectContaining({ _: "inputPeerChannel" }),
      id: OWN_IN_FORUM,
      silent: true,
    })
  })

  test("unpins with the unpin flag, silent, and says the message is not pinned", async () => {
    expect(await pin(fixture, { chat: KEPT, id: THEIRS, unpin: true })).toEqual({ id: THEIRS, pinned: false })

    expect(request()).toEqual({
      _: "messages.updatePinnedMessage",
      peer: user,
      id: THEIRS,
      silent: true,
      unpin: true,
      pmOneside: true,
    })
  })

  test("tells mtcute's update state, which dispatches nothing", async () => {
    await pin(fixture, { chat: KEPT, id: THEIRS })

    expect(fixture.client.handled).toHaveLength(1)
    expect(fixture.client.handled[0]).toMatchObject({ update: { _: "updates" }, noDispatch: true })
  })

  test("of a message of the user's own is allowed too", async () => {
    expect(await pin(fixture, { chat: KEPT, id: OWN.text })).toEqual({ id: OWN.text, pinned: true })
  })
})

describe("a pin that makes a service message", () => {
  test("records it as the user's own message, the way a send is recorded", async () => {
    fixture.client.setActionAnswer(pinnedAnswer(THEIRS, { service: true }))

    await pin(fixture, { chat: KEPT, id: THEIRS, notify: true, both_sides: true })

    expect(row(KEPT, PIN_SERVICE_ID)).toMatchObject({
      kind: "service",
      from_me: 1,
      ts: PIN_DATE * 1000,
      action: expect.stringContaining("message_pinned"),
    })
  })

  test("in a supergroup is recorded in that chat", async () => {
    fixture.client.setActionAnswer(pinnedAnswer(OWN_IN_FORUM, { forum: true, service: true }))

    await pin(fixture, { chat: FORUM, id: OWN_IN_FORUM, notify: true })

    expect(row(FORUM, PIN_SERVICE_ID)).toMatchObject({ kind: "service", from_me: 1 })
    expect(row(KEPT, PIN_SERVICE_ID)).toBeUndefined()
  })

  test("is recorded once, though the same pin comes as an update afterwards", async () => {
    fixture.client.setActionAnswer(pinnedAnswer(THEIRS, { service: true }))
    await pin(fixture, { chat: KEPT, id: THEIRS, notify: true })

    await pin(fixture, { chat: KEPT, id: THEIRS, notify: true })

    expect(messageIds(KEPT).filter((id) => id === PIN_SERVICE_ID)).toHaveLength(1)
  })

  test("is not made up when the answer carries none: nothing is stored, and the pin itself is not mirrored", async () => {
    const before = messageIds(KEPT)

    await pin(fixture, { chat: KEPT, id: THEIRS, notify: true })

    expect(messageIds(KEPT)).toEqual(before)
  })

  test("is left out when it is another chat's, or the answer holds no group", async () => {
    fixture.client.setActionAnswer(pinnedAnswer(THEIRS, { forum: true, service: true }))
    await pin(fixture, { chat: KEPT, id: THEIRS })
    fixture.client.setActionAnswer({ _: "updatesTooLong" })
    await pin(fixture, { chat: KEPT, id: THEIRS })

    expect(row(KEPT, PIN_SERVICE_ID)).toBeUndefined()
    expect(row(FORUM, PIN_SERVICE_ID)).toBeUndefined()
  })

  test("is no reason to fail the pin when the answer holds nothing", async () => {
    fixture.client.setActionAnswer(updatesGroup([]))

    expect(await pin(fixture, { chat: KEPT, id: THEIRS })).toEqual({ id: THEIRS, pinned: true })
  })
})

describe("a pin Telegram answers is unchanged", () => {
  beforeEach(() => fixture.client.setActionAnswer(answered(400, "CHAT_NOT_MODIFIED")))

  test("for a pin is done", async () => {
    expect(await pin(fixture, { chat: KEPT, id: THEIRS })).toEqual({ id: THEIRS, pinned: true, already: true })
    expect(actionsOf(fixture)).toHaveLength(1)
  })

  test("for an unpin is done, and the message is not pinned", async () => {
    expect(await pin(fixture, { chat: KEPT, id: THEIRS, unpin: true })).toEqual({
      id: THEIRS,
      pinned: false,
      already: true,
    })
  })

  test("is done also when the connection came back during the call", async () => {
    fixture.client.setActionAnswer(() => {
      fixture.client.drop()
      fixture.client.regain()
      return answered(400, "CHAT_NOT_MODIFIED")
    })

    expect(await pin(fixture, { chat: KEPT, id: THEIRS })).toMatchObject({ already: true })
  })
})
