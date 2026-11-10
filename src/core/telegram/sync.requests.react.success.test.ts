import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { answered } from "./sync-client-send.testing"
import { FORUM, KEPT } from "./sync-requests.testing"
import { actionsOf } from "./sync-action.testing"
import {
  FIRE,
  PARTY,
  REACTED,
  REACTED_IN_FORUM,
  THUMBS,
  react,
  reactedAnswer,
  reactionsStored,
  seedReactionChats,
  silentAnswer,
} from "./sync-react.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeEach(async () => {
  fixture = syncFixture()
  seedReactionChats(fixture)
  await fixture.running()
  fixture.client.setActionAnswer(silentAnswer())
})

afterEach(() => fixture.close())

const stored = (id: number, chat: string = KEPT) => reactionsStored(fixture, chat, id)

describe("a reaction Telegram accepts", () => {
  test("sets the emoji in one call that replaces the user's reactions, with retries and sleeps off", async () => {
    expect(await react(fixture, { chat: KEPT, id: REACTED.mine, emoji: PARTY })).toEqual({
      id: REACTED.mine,
      emoji: PARTY,
    })

    const [only, ...rest] = actionsOf(fixture)
    expect(rest).toEqual([])
    expect(only?.options).toMatchObject({ maxRetryCount: 0, floodSleepThreshold: 0 })
    expect(only?.options.abortSignal).toBeInstanceOf(AbortSignal)
    expect(only?.request).toEqual({
      _: "messages.sendReaction",
      peer: { _: "inputPeerUser", userId: Number(KEPT), accessHash: expect.anything() },
      msgId: REACTED.mine,
      reaction: [{ _: "reactionEmoji", emoticon: PARTY }],
    })
  })

  test("removes the reaction with an empty list", async () => {
    expect(await react(fixture, { chat: KEPT, id: REACTED.mine, remove: true })).toEqual({
      id: REACTED.mine,
      removed: true,
    })

    expect(actionsOf(fixture)[0]?.request).toEqual({
      _: "messages.sendReaction",
      peer: { _: "inputPeerUser", userId: Number(KEPT), accessHash: expect.anything() },
      msgId: REACTED.mine,
      reaction: [],
    })
  })

  test("in a supergroup goes to its channel and is recorded there", async () => {
    fixture.client.setActionAnswer(reactedAnswer(REACTED_IN_FORUM, [{ emoji: FIRE, count: 1, chosen: 0 }], true))

    expect(await react(fixture, { chat: FORUM, id: REACTED_IN_FORUM, emoji: FIRE })).toEqual({
      id: REACTED_IN_FORUM,
      emoji: FIRE,
    })

    expect(actionsOf(fixture)[0]?.request).toMatchObject({ peer: { _: "inputPeerChannel" }, msgId: REACTED_IN_FORUM })
    expect(stored(REACTED_IN_FORUM, FORUM)).toEqual([{ emoji: FIRE, count: 1, mine: true }])
  })

  test("tells mtcute's update state, which dispatches nothing", async () => {
    await react(fixture, { chat: KEPT, id: REACTED.mine, emoji: PARTY })

    expect(fixture.client.handled).toHaveLength(1)
    expect(fixture.client.handled[0]).toMatchObject({ update: { _: "updates" }, noDispatch: true })
  })
})

describe("a reaction recorded in the mirror", () => {
  test("moves the user's own to the new emoji: one fewer for the old, one more for the new", async () => {
    await react(fixture, { chat: KEPT, id: REACTED.mine, emoji: PARTY })

    expect(stored(REACTED.mine)).toEqual([
      { emoji: THUMBS, count: 1 },
      { emoji: PARTY, count: 2, mine: true },
    ])
  })

  test("drops the old emoji when the user's was the only one", async () => {
    await react(fixture, { chat: KEPT, id: REACTED.only, emoji: PARTY })

    expect(stored(REACTED.only)).toEqual([{ emoji: PARTY, count: 1, mine: true }])
  })

  test("adds the emoji beside the reactions of others on a message the user had not reacted to", async () => {
    await react(fixture, { chat: KEPT, id: REACTED.others, emoji: THUMBS })

    expect(stored(REACTED.others)).toEqual([
      { emoji: PARTY, count: 3 },
      { emoji: THUMBS, count: 1, mine: true },
    ])
  })

  test("starts the reactions of a message that had none", async () => {
    await react(fixture, { chat: KEPT, id: REACTED.none, emoji: THUMBS })

    expect(stored(REACTED.none)).toEqual([{ emoji: THUMBS, count: 1, mine: true }])
  })

  test("takes the user's own away on a removal, and clears the list when nothing is left", async () => {
    await react(fixture, { chat: KEPT, id: REACTED.mine, remove: true })
    await react(fixture, { chat: KEPT, id: REACTED.only, remove: true })

    expect(stored(REACTED.mine)).toEqual([
      { emoji: THUMBS, count: 1 },
      { emoji: PARTY, count: 1 },
    ])
    expect(stored(REACTED.only)).toBeNull()
  })

  test("leaves the reactions of others as they are on a removal of a reaction the mirror did not know", async () => {
    await react(fixture, { chat: KEPT, id: REACTED.others, remove: true })

    expect(stored(REACTED.others)).toEqual([{ emoji: PARTY, count: 3 }])
  })

  test("takes Telegram's own counts when the answer carries them", async () => {
    fixture.client.setActionAnswer(
      reactedAnswer(REACTED.mine, [
        { emoji: PARTY, count: 5, chosen: 0 },
        { emoji: THUMBS, count: 4 },
      ]),
    )

    await react(fixture, { chat: KEPT, id: REACTED.mine, emoji: PARTY })

    expect(stored(REACTED.mine)).toEqual([
      { emoji: PARTY, count: 5, mine: true },
      { emoji: THUMBS, count: 4 },
    ])
  })

  test("takes Telegram's counts of the message asked about only, not another's", async () => {
    fixture.client.setActionAnswer(reactedAnswer(REACTED.only, [{ emoji: FIRE, count: 9 }]))

    await react(fixture, { chat: KEPT, id: REACTED.mine, emoji: PARTY })

    expect(stored(REACTED.mine)).toEqual([
      { emoji: THUMBS, count: 1 },
      { emoji: PARTY, count: 2, mine: true },
    ])
    expect(stored(REACTED.only)).toEqual([{ emoji: THUMBS, count: 1, mine: true }])
  })

  test("takes an empty list of Telegram's as every reaction gone", async () => {
    fixture.client.setActionAnswer(reactedAnswer(REACTED.mine, []))

    await react(fixture, { chat: KEPT, id: REACTED.mine, remove: true })

    expect(stored(REACTED.mine)).toBeNull()
  })

  test("never changes another message's reactions", async () => {
    await react(fixture, { chat: KEPT, id: REACTED.mine, emoji: PARTY })

    expect(stored(REACTED.others)).toEqual([{ emoji: PARTY, count: 3 }])
    expect(stored(REACTED_IN_FORUM, FORUM)).toEqual([{ emoji: THUMBS, count: 2 }])
  })
})

describe("a reaction Telegram answers is unchanged", () => {
  beforeEach(() => fixture.client.setActionAnswer(answered(400, "MESSAGE_NOT_MODIFIED")))

  test("for an emoji the mirror did not show is done, and the mirror is left as it was", async () => {
    expect(await react(fixture, { chat: KEPT, id: REACTED.others, emoji: PARTY })).toEqual({
      id: REACTED.others,
      emoji: PARTY,
      already: true,
    })

    expect(actionsOf(fixture)).toHaveLength(1)
    expect(stored(REACTED.others)).toEqual([{ emoji: PARTY, count: 3 }])
  })

  test("for a removal of nothing is done", async () => {
    expect(await react(fixture, { chat: KEPT, id: REACTED.others, remove: true })).toEqual({
      id: REACTED.others,
      removed: true,
      already: true,
    })
  })

  test("is done also when the connection came back during the call", async () => {
    fixture.client.setActionAnswer(() => {
      fixture.client.drop()
      fixture.client.regain()
      return answered(400, "MESSAGE_NOT_MODIFIED")
    })

    expect(await react(fixture, { chat: KEPT, id: REACTED.others, emoji: PARTY })).toMatchObject({ already: true })
  })
})
