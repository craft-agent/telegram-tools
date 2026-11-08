import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Message } from "@mtcute/core"
import {
  FAKE_IDS,
  channelPeer,
  fakeChannel,
  fakeMessage,
  fakeSupergroup,
  fakeUser,
  messageOf,
} from "./fake-telegram.testing"
import { messageRow } from "./mirror.testing"
import type { RefreshResult } from "./service-requests"
import { REFRESH_REUSE_MS } from "./sync-chat-refresh"
import { CHANNEL_ID, SUPERGROUP_ID, followedOf, holdings, seedSyncChat, type SeededChat } from "./sync-list.testing"
import { request } from "./sync-requests.testing"
import { START_MS, eventually, fakeDialogFor, syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeEach(() => {
  fixture = syncFixture()
})

afterEach(() => fixture.close())

const SUPERGROUP: SeededChat = { id: SUPERGROUP_ID, kind: "supergroup" }
const CHANNEL: SeededChat = { id: CHANNEL_ID, kind: "channel" }

/** A chat the list names but the mirror does not follow, as a change made while the service runs would leave it. */
const listed = (chat: SeededChat): SeededChat => ({ ...chat, listed: true, followed: false, ids: [] })

/** A chat the mirror follows and the list does not name, with messages. */
const leftover = (chat: SeededChat): SeededChat => ({ ...chat, listed: false, followed: true })

/** Starts the service and waits for the refresh it makes on its own at the start. */
async function runAfterFirstRefresh(overrides: Parameters<SyncFixture["running"]>[0] = {}): Promise<void> {
  await fixture.running(overrides)
  await eventually(() => fixture.meta().refreshed_at === String(START_MS))
}

async function refresh(): Promise<void> {
  fixture.clock.advance(REFRESH_REUSE_MS + 1_000)
  await request<RefreshResult>(fixture, "refresh")
}

const alice = fakeUser()
const supergroupMessage = (): Message =>
  messageOf(fakeMessage({ id: 7, peerId: channelPeer() }), fakeSupergroup(), alice)
const channelMessage = (): Message =>
  messageOf(fakeMessage({ id: 7, peerId: channelPeer(FAKE_IDS.channel) }), fakeChannel(), alice)
const stored = (chat: string) => fixture.mirror((mirror) => messageRow(mirror, chat, 7)) !== undefined

describe("a chat list refresh", () => {
  test("follows a supergroup that is on the list", async () => {
    fixture.client.setDialogs(fakeDialogFor(channelPeer()))
    await runAfterFirstRefresh()
    expect(followedOf(fixture, SUPERGROUP_ID)).toBe(0)
    seedSyncChat(fixture, listed(SUPERGROUP))

    await refresh()

    expect(followedOf(fixture, SUPERGROUP_ID)).toBe(1)
  })

  test("deletes the messages of a supergroup that is not on the list, and leaves the chat known", async () => {
    fixture.client.setDialogs(fakeDialogFor(channelPeer()))
    await runAfterFirstRefresh()
    seedSyncChat(fixture, leftover(SUPERGROUP))

    await refresh()

    expect(followedOf(fixture, SUPERGROUP_ID)).toBe(0)
    expect(holdings(fixture, SUPERGROUP_ID)).toMatchObject({ chats: 1, messages: 0, edits: 0 })
  })

  test("follows a channel that is on the list, with channels on", async () => {
    fixture.client.setDialogs(fakeDialogFor(channelPeer(FAKE_IDS.channel)))
    await runAfterFirstRefresh({ channels: true })
    seedSyncChat(fixture, listed(CHANNEL))

    await refresh()

    expect(followedOf(fixture, CHANNEL_ID)).toBe(1)
  })
})

describe("a pushed message", () => {
  test("follows a supergroup that is on the list, and is stored", async () => {
    await fixture.running()
    seedSyncChat(fixture, listed(SUPERGROUP))

    fixture.client.onNewMessage.emit(supergroupMessage())

    expect(followedOf(fixture, SUPERGROUP_ID)).toBe(1)
    expect(stored(SUPERGROUP_ID)).toBe(true)
  })

  test("is dropped for a supergroup that is not on the list, and takes its earlier messages with it", async () => {
    await fixture.running()
    seedSyncChat(fixture, leftover(SUPERGROUP))

    fixture.client.onNewMessage.emit(supergroupMessage())

    expect(followedOf(fixture, SUPERGROUP_ID)).toBe(0)
    expect(stored(SUPERGROUP_ID)).toBe(false)
    expect(holdings(fixture, SUPERGROUP_ID)).toMatchObject({ messages: 0, edits: 0 })
    expect(fixture.logs).toContain("event: message dropped-unfollowed")
  })

  test("is stored for a channel that is on the list, with channels on", async () => {
    await fixture.running({ channels: true })
    seedSyncChat(fixture, listed(CHANNEL))

    fixture.client.onNewMessage.emit(channelMessage())

    expect(followedOf(fixture, CHANNEL_ID)).toBe(1)
    expect(stored(CHANNEL_ID)).toBe(true)
  })

  test("is dropped for a channel that is not on the list, with channels on", async () => {
    await fixture.running({ channels: true })
    seedSyncChat(fixture, leftover(CHANNEL))

    fixture.client.onNewMessage.emit(channelMessage())

    expect(followedOf(fixture, CHANNEL_ID)).toBe(0)
    expect(stored(CHANNEL_ID)).toBe(false)
  })
})
