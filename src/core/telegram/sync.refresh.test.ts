import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { FAKE_DATE, FAKE_IDS, FAKE_MARKED, channelPeer, chatPeer, userPeer } from "./fake-telegram.testing"
import { setFollowed, upsertChats } from "./ingest-chats"
import { storeMessage } from "./ingest-messages"
import { floodWait, rpcError } from "./login.testing"
import { chatRow, messageInput, chatInput, columnOf, rowsOf } from "./mirror.testing"
import { START_MS, eventually, fakeDialogFor, fakeHistory, syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeEach(() => {
  fixture = syncFixture()
})

afterEach(() => fixture.close())

const DAY_S = 86_400
const alice = userPeer()
const aliceChat = Number(FAKE_MARKED.alice)

/** Alice's chat as an earlier run left it: followed, with the messages `ids` stored. */
function seedAlice(...ids: number[]): void {
  fixture.seed((mirror) => {
    upsertChats(mirror, [chatInput({ id: FAKE_MARKED.alice })], START_MS)
    setFollowed(mirror, FAKE_MARKED.alice, true)
    for (const id of ids) {
      const message = messageInput({ chat: FAKE_MARKED.alice, id, ts: START_MS - 60_000 })
      storeMessage(mirror, { now: START_MS, keepDisappearing: false }, message)
    }
  })
}

const storedIds = (chat: string) =>
  fixture.mirror((m) => columnOf(m, "SELECT id FROM messages WHERE chat = ? ORDER BY id", chat))
const histories = () => fixture.client.argsOf("getHistory") as { chat: number; limit: number; minId?: number }[]

describe("the chat list refresh", () => {
  test("lists every chat, archived ones included, follows the kinds it follows and only lists the others", async () => {
    fixture.client.setDialogs(
      fakeDialogFor(alice),
      fakeDialogFor(userPeer(FAKE_IDS.bot)),
      fakeDialogFor(chatPeer()),
      fakeDialogFor(channelPeer()),
      fakeDialogFor(channelPeer(FAKE_IDS.channel)),
    )

    await fixture.running()

    const kinds = fixture.mirror((m) => rowsOf(m, "SELECT kind, followed FROM chats ORDER BY id"))
    expect(kinds).toEqual([
      { kind: "supergroup", followed: 0 },
      { kind: "group", followed: 1 },
      { kind: "user", followed: 1 },
      { kind: "bot", followed: 1 },
    ])
    expect(fixture.client.argsOf("iterDialogs")).toEqual([{ archived: "keep" }])
    expect(fixture.meta().refreshed_at).toBe(String(START_MS))
    expect(fixture.logs).toContain("refreshed 4 chats, filled 0 messages")
  })

  test("lists channels too with channels on, without following them", async () => {
    fixture.client.setDialogs(fakeDialogFor(channelPeer(FAKE_IDS.channel)))

    await fixture.running({ channels: true })

    expect(fixture.mirror((m) => chatRow(m, FAKE_MARKED.channel))).toMatchObject({ kind: "channel", followed: 0 })
  })

  test("keeps the unread count, read position and newest message the dialog shows", async () => {
    fixture.client.setDialogs(fakeDialogFor(alice, 9))

    await fixture.running()

    expect(fixture.mirror((m) => chatRow(m, FAKE_MARKED.alice))).toMatchObject({ unread: 2, read_max: 8, top_id: 9 })
  })

  test("comes again when the interval has passed on the clock, and not before", async () => {
    await fixture.running({ refreshEveryMs: 1_000 })
    expect(fixture.client.argsOf("iterDialogs")).toHaveLength(1)

    fixture.clock.advance(1_000)

    await eventually(() => fixture.client.argsOf("iterDialogs").length === 2)
  })

  test("that fails is logged by Telegram's name for the error and tried again after the retry interval", async () => {
    fixture.client.fail("iterDialogs", rpcError(500, "RPC_CALL_FAIL"))

    await fixture.running({ refreshRetryMs: 1_000 })
    await eventually(() => fixture.logs.includes("chat list refresh failed: RPC_CALL_FAIL"))
    expect(fixture.meta().refreshed_at).toBeUndefined()
    fixture.clock.advance(1_000)

    await eventually(() => fixture.meta().refreshed_at === String(START_MS + 1_000))
  })
})

describe("gap filling", () => {
  test("fetches the messages above the newest stored one of a chat the dialog shows newer", async () => {
    seedAlice(4, 5)
    fixture.client.setDialogs(fakeDialogFor(alice, 9))
    fixture.client.setHistory(FAKE_MARKED.alice, ...fakeHistory(alice, 3, 4, 5, 6, 7, 8, 9))

    await fixture.running()
    await eventually(() => storedIds(FAKE_MARKED.alice).length === 6)

    expect(histories()).toEqual([{ chat: aliceChat, limit: 200, minId: 5 }])
    expect(storedIds(FAKE_MARKED.alice)).toEqual([4, 5, 6, 7, 8, 9])
    expect(fixture.pauses).toHaveLength(1)
    expect(fixture.pauses[0]).toBeGreaterThanOrEqual(500)
    expect(fixture.pauses[0]).toBeLessThanOrEqual(1500)
  })

  test("leaves the unread count the dialog gave, since fetched messages are not new ones", async () => {
    seedAlice(5)
    fixture.client.setDialogs(fakeDialogFor(alice, 9))
    fixture.client.setHistory(FAKE_MARKED.alice, ...fakeHistory(alice, 6, 7, 8, 9))

    await fixture.running()
    await eventually(() => storedIds(FAKE_MARKED.alice).length === 5)

    expect(fixture.mirror((m) => chatRow(m, FAKE_MARKED.alice))).toMatchObject({ unread: 2, top_id: 9 })
  })

  test("fetches at most the limit, taking the newest", async () => {
    seedAlice(5)
    fixture.client.setDialogs(fakeDialogFor(alice, 9))
    fixture.client.setHistory(FAKE_MARKED.alice, ...fakeHistory(alice, 6, 7, 8, 9))

    await fixture.running({ fillLimit: 2 })
    await eventually(() => storedIds(FAKE_MARKED.alice).length === 3)

    expect(storedIds(FAKE_MARKED.alice)).toEqual([5, 8, 9])
  })

  test("asks for nothing when the newest stored message is the dialog's", async () => {
    seedAlice(9)
    fixture.client.setDialogs(fakeDialogFor(alice, 9))

    await fixture.running()
    await eventually(() => fixture.logs.includes("refreshed 1 chats, filled 0 messages"))

    expect(histories()).toEqual([])
  })
})

describe("seeding", () => {
  const group = chatPeer()

  test("gives a chat active in the last 30 days its newest 50 messages, and leaves quieter chats alone", async () => {
    const quiet = userPeer(FAKE_IDS.bot)
    fixture.client.setDialogs(
      fakeDialogFor(alice, 3),
      fakeDialogFor(group, 2),
      fakeDialogFor(quiet, 4, FAKE_DATE - 31 * DAY_S),
    )
    fixture.client.setHistory(FAKE_MARKED.alice, ...fakeHistory(alice, 1, 2, 3))
    fixture.client.setHistory(FAKE_MARKED.group, ...fakeHistory(group, 1, 2))

    await fixture.running()
    await eventually(() => storedIds(FAKE_MARKED.alice).length === 3 && storedIds(FAKE_MARKED.group).length === 2)

    expect(
      histories()
        .map((call) => call.chat)
        .sort(),
    ).toEqual([Number(FAKE_MARKED.group), aliceChat].sort())
    expect(histories().every((call) => call.limit === 50 && call.minId === undefined)).toBe(true)
    expect(storedIds(FAKE_MARKED.bot)).toEqual([])
  })

  test("seeds at most the limit of chats in a round", async () => {
    fixture.client.setDialogs(fakeDialogFor(alice, 3), fakeDialogFor(group, 2))
    fixture.client.setHistory(FAKE_MARKED.alice, ...fakeHistory(alice, 1, 2, 3))
    fixture.client.setHistory(FAKE_MARKED.group, ...fakeHistory(group, 1, 2))

    await fixture.running({ seedChatsPerRound: 1, roundEveryMs: 1_000_000 })
    await eventually(() => histories().length === 1 && fixture.logs.includes("seeded 1 chats"))

    expect(histories()).toHaveLength(1)
  })

  test("goes on with the rest in the next round", async () => {
    fixture.client.setDialogs(fakeDialogFor(alice, 3), fakeDialogFor(group, 2))
    fixture.client.setHistory(FAKE_MARKED.alice, ...fakeHistory(alice, 1, 2, 3))
    fixture.client.setHistory(FAKE_MARKED.group, ...fakeHistory(group, 1, 2))

    await fixture.running({ seedChatsPerRound: 1 })

    await eventually(() => storedIds(FAKE_MARKED.alice).length === 3 && storedIds(FAKE_MARKED.group).length === 2)
  })

  test("a chat that comes back empty is not asked again", async () => {
    fixture.client.setDialogs(fakeDialogFor(alice, 3))

    await fixture.running()
    await eventually(() => histories().length === 1)
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(histories()).toHaveLength(1)
  })

  test("a failed fetch is logged by the error's name and tried again in the next round, up to the attempts", async () => {
    fixture.client.setDialogs(fakeDialogFor(alice, 3))
    fixture.client.fail("getHistory", rpcError(400, "CHAT_FORBIDDEN"), 5)

    await fixture.running({ seedAttempts: 2 })
    await eventually(() => histories().length === 2)
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(histories()).toHaveLength(2)
    expect(fixture.logs.filter((line) => line === "seeding failed: CHAT_FORBIDDEN")).toHaveLength(2)
  })

  test("a flood wait is waited out, the next chat goes on, and the chat that was refused comes again", async () => {
    fixture.client.setDialogs(fakeDialogFor(alice, 3), fakeDialogFor(group, 2))
    fixture.client.setHistory(FAKE_MARKED.alice, ...fakeHistory(alice, 1, 2, 3))
    fixture.client.setHistory(FAKE_MARKED.group, ...fakeHistory(group, 1, 2))
    fixture.client.fail("getHistory", floodWait(7))

    await fixture.running()
    await eventually(() => storedIds(FAKE_MARKED.alice).length === 3 && storedIds(FAKE_MARKED.group).length === 2)

    expect(fixture.pauses.filter((ms) => ms === 7_000)).toHaveLength(1)
    expect(fixture.logs).toContain("seeding: flood wait of 7 seconds")
    expect(fixture.logs.some((line) => line.includes("failed"))).toBe(false)
  })

  test("flood waits do not count as tries: more of them than the attempts still seed the chat", async () => {
    fixture.client.setDialogs(fakeDialogFor(alice, 3))
    fixture.client.setHistory(FAKE_MARKED.alice, ...fakeHistory(alice, 1, 2, 3))
    fixture.client.fail("getHistory", floodWait(1), 3)

    await fixture.running({ seedAttempts: 2 })
    await eventually(() => storedIds(FAKE_MARKED.alice).length === 3)

    expect(histories()).toHaveLength(4)
  })

  test("a flood wait is cut short by a stop request", async () => {
    fixture.client.setDialogs(fakeDialogFor(alice, 3))
    fixture.client.fail("getHistory", floodWait(3_600))

    const { stop, outcome } = await fixture.running({
      pause: (ms) => (ms === 3_600_000 ? new Promise(() => {}) : Promise.resolve()),
    })
    await eventually(() => fixture.logs.includes("seeding: flood wait of 3600 seconds"))
    stop()

    expect(await outcome).toEqual({ exitCode: 0, status: "stopped" })
  })
})
