import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { DeleteMessageUpdate, HistoryReadUpdate, type Message } from "@mtcute/core"
import {
  FAKE_DATE,
  FAKE_IDS,
  FAKE_MARKED,
  FAKE_PRIVATE_VALUES,
  channelPeer,
  chatPeer,
  fakeBasicGroup,
  fakeChannel,
  fakeDeleteUpdate,
  fakeMessage,
  fakeOutboxReadUpdate,
  fakeReadUpdate,
  fakeServiceMessage,
  fakeSupergroup,
  fakeUser,
  messageOf,
} from "./fake-telegram.testing"
import { chatRow, messageRow, rowsOf } from "./mirror.testing"
import { START_MS, aliceMessage, syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture
/** Starts the service with the options and waits until it runs. */
async function startService(overrides: Parameters<SyncFixture["start"]>[0] = {}): Promise<void> {
  // The beat is left to the first one, so only a delete's own check can record a gap.
  await fixture.running({ heartbeatEveryMs: 1_000_000, ...overrides })
}

beforeEach(() => {
  fixture = syncFixture()
})

afterEach(() => fixture.close())

const push = (message: Message) => fixture.client.onNewMessage.emit(message)

const chatOf = (id: string) => fixture.mirror((m) => chatRow(m, id))

const alice = fakeUser()

function superMessage(id = 1, overrides = {}): Message {
  return messageOf(fakeMessage({ id, peerId: channelPeer(), ...overrides }), fakeSupergroup(), alice)
}

describe("the service storing what is pushed", () => {
  test("a new message creates its chat, follows it, and is stored with the time it was received", async () => {
    await startService()
    fixture.clock.advance(500)

    push(aliceMessage(1, "hello"))

    expect(chatOf(FAKE_MARKED.alice)).toMatchObject({ kind: "user", followed: 1, unread: 1 })
    expect(fixture.mirror((m) => messageRow(m, FAKE_MARKED.alice, 1))).toMatchObject({ body: "hello", from_me: 0 })
    expect(fixture.meta().last_received_at).toBe(String(START_MS + 500))
    expect(fixture.logs).toContain("event: message stored")
  })

  test("an edit replaces the text and keeps the version before it", async () => {
    await startService()
    push(aliceMessage(1, "first"))

    const edited = fakeMessage({ id: 1, message: "second", editDate: FAKE_DATE + 60 })
    fixture.client.onEditMessage.emit(messageOf(edited, alice))

    expect(fixture.mirror((m) => messageRow(m, FAKE_MARKED.alice, 1))).toMatchObject({ body: "second" })
    expect(fixture.mirror((m) => rowsOf(m, "SELECT body FROM edits"))).toEqual([{ body: "first" }])
    expect(fixture.logs).toContain("event: edit edited")
  })

  test("a delete for everyone removes the message", async () => {
    await startService()
    push(aliceMessage(1))

    fixture.client.onDeleteMessage.emit(new DeleteMessageUpdate(fakeDeleteUpdate([1])))

    expect(fixture.mirror((m) => messageRow(m, FAKE_MARKED.alice, 1))).toBeUndefined()
    expect(fixture.logs).toContain("event: delete removed=1")
  })

  test("a delete after the connection dropped records a gap first, so the timer rule sees it", async () => {
    await startService()
    push(aliceMessage(1))
    fixture.client.drop()
    fixture.client.regain()
    fixture.clock.advance(2_000)

    fixture.client.onDeleteMessage.emit(new DeleteMessageUpdate(fakeDeleteUpdate([1])))

    expect(fixture.mirror((m) => rowsOf(m, "SELECT start, until FROM gaps"))).toEqual([
      { start: START_MS, until: START_MS + 2_000 },
    ])
  })

  test("a delete with the connection up and no stall records no gap", async () => {
    await startService()
    fixture.clock.advance(2_000)

    fixture.client.onDeleteMessage.emit(new DeleteMessageUpdate(fakeDeleteUpdate([1])))

    expect(fixture.mirror((m) => rowsOf(m, "SELECT * FROM gaps"))).toEqual([])
  })

  test("a read on another device moves the chat's read position and unread count", async () => {
    await startService()
    push(aliceMessage(1))

    fixture.client.onHistoryRead.emit(new HistoryReadUpdate(fakeReadUpdate()))

    expect(chatOf(FAKE_MARKED.alice)).toMatchObject({ read_max: 10, unread: 2 })
    expect(fixture.logs).toContain("event: read applied")
  })

  test("a read of the account's own messages is skipped and leaves last_received_at alone", async () => {
    await startService()

    fixture.client.onHistoryRead.emit(new HistoryReadUpdate(fakeOutboxReadUpdate()))

    expect(fixture.logs).toContain("event: read skipped")
    expect(fixture.meta().last_received_at).toBeUndefined()
  })

  test("a message of a basic group is stored in its followed chat", async () => {
    await startService()

    push(messageOf(fakeMessage({ peerId: chatPeer(), fromId: undefined }), fakeBasicGroup(), alice))

    expect(chatOf(FAKE_MARKED.group)).toMatchObject({ kind: "group", followed: 1 })
    expect(fixture.mirror((m) => messageRow(m, FAKE_MARKED.group, 1))).toBeDefined()
  })

  test("a message that cannot be read is skipped and the next one is stored", async () => {
    await startService()
    const broken = {
      get raw(): never {
        throw new Error("broken")
      },
    } as unknown as Message

    push(broken)
    push(aliceMessage(2))

    expect(fixture.logs).toContain("event: message unreadable (Error)")
    expect(fixture.mirror((m) => messageRow(m, FAKE_MARKED.alice, 2))).toBeDefined()
  })
})

describe("the service and chats it does not follow", () => {
  test("a supergroup is listed, not followed, and its messages are not stored", async () => {
    await startService()

    push(superMessage())

    expect(chatOf(FAKE_MARKED.supergroup)).toMatchObject({ kind: "supergroup", followed: 0 })
    expect(fixture.mirror((m) => rowsOf(m, "SELECT * FROM messages"))).toEqual([])
    expect(fixture.logs).toContain("event: message dropped-unfollowed")
  })

  test("a delete in a chat that is not followed leaves no trace of the message", async () => {
    await startService()
    push(superMessage())

    fixture.client.onDeleteMessage.emit(new DeleteMessageUpdate(fakeDeleteUpdate([1], FAKE_IDS.supergroup)))

    expect(fixture.mirror((m) => rowsOf(m, "SELECT * FROM deleted"))).toEqual([])
    expect(fixture.logs).toContain("event: delete skipped")
  })

  test("a channel is not stored at all while channels are off", async () => {
    await startService()

    push(messageOf(fakeMessage({ peerId: channelPeer(FAKE_IDS.channel) }), fakeChannel(), alice))

    expect(fixture.mirror((m) => rowsOf(m, "SELECT * FROM chats"))).toEqual([])
    expect(fixture.meta().last_received_at).toBeUndefined()
    expect(fixture.logs).toContain("event: message skipped")
  })

  test("a channel is listed, not followed, and not stored while channels are on", async () => {
    await startService({ channels: true })

    push(messageOf(fakeMessage({ peerId: channelPeer(FAKE_IDS.channel) }), fakeChannel(), alice))

    expect(chatOf(FAKE_MARKED.channel)).toMatchObject({ kind: "channel", followed: 0 })
    expect(fixture.mirror((m) => rowsOf(m, "SELECT * FROM messages"))).toEqual([])
  })

  test("a forum topic that a service message creates or renames is stored", async () => {
    await startService()
    const forum = fakeSupergroup({ forum: true })
    const created = fakeServiceMessage(
      { _: "messageActionTopicCreate", title: "New Topic", iconColor: 1 },
      { id: 12, peerId: channelPeer() },
    )

    push(messageOf(created, forum, alice))

    expect(fixture.mirror((m) => rowsOf(m, "SELECT chat, id, title FROM topics"))).toEqual([
      { chat: FAKE_MARKED.supergroup, id: 12, title: "New Topic" },
    ])
  })
})

describe("the service's log", () => {
  test("names only the kind of each update, never ids, names or text", async () => {
    await startService({ channels: true })

    push(aliceMessage(1, "a private secret"))
    push(superMessage())
    fixture.client.onEditMessage.emit(
      messageOf(fakeMessage({ message: "edited secret", editDate: FAKE_DATE + 1 }), alice),
    )
    fixture.client.onDeleteMessage.emit(new DeleteMessageUpdate(fakeDeleteUpdate([1])))
    fixture.client.onHistoryRead.emit(new HistoryReadUpdate(fakeReadUpdate()))

    const log = fixture.logs.join("\n")
    const secrets = [
      ...FAKE_PRIVATE_VALUES,
      ...Object.values(FAKE_MARKED),
      ...Object.values(FAKE_IDS).map(String),
      "secret",
      "Alice",
      "alice_example",
      "Example Supergroup",
    ]
    for (const secret of secrets) expect(log).not.toContain(secret)
    expect(fixture.logs.filter((line) => line.startsWith("event: "))).toHaveLength(5)
  })
})
