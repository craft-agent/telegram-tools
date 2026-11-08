import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { dirname } from "node:path"
import { fakeDiceMedia, fakePhotoMedia, fakePollMedia, fakeViewOncePhotoMedia } from "./fake-telegram-media.testing"
import {
  FAKE_IDS,
  FAKE_MARKED,
  channelPeer,
  fakeChannel,
  fakeMessage,
  fakeUser,
  messageOf,
  userPeer,
} from "./fake-telegram.testing"
import { upsertChats } from "./ingest-chats"
import { chatInput } from "./mirror.testing"
import { DOWNLOAD_MAX_BYTES } from "./service-requests"
import { failureOf } from "./service.testing"
import { CHAT, download, fileMedia, incomingFolders, mediaMessage } from "./sync-download.testing"
import { INT32_MAX } from "./sync-request-params"
import { KEPT, UNLISTED, request, seedListedChats } from "./sync-requests.testing"
import { START_MS, syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeAll(async () => {
  fixture = syncFixture()
  seedListedChats(fixture)
  fixture.client.setHistory(CHAT, mediaMessage(1, fileMedia("a.txt", "text/plain", 3)), mediaMessage(2, undefined))
  fixture.client.setDownload([Uint8Array.of(1, 2, 3)])
  await fixture.running()
})

afterAll(() => fixture.close())

beforeEach(() => void (fixture.client.calls.length = 0))

const refusal = (params: unknown) => failureOf(request(fixture, "download", params as Record<string, unknown>))
const nothingAsked = () => {
  expect(fixture.client.argsOf("getMessages")).toEqual([])
  expect(fixture.client.argsOf("downloadAsIterable")).toEqual([])
  expect(incomingFolders(fixture)).toEqual([])
}

describe("download parameters", () => {
  const ok = { chat: CHAT, id: 1, max_bytes: 1000 }
  const bad: [string, unknown][] = [
    ["no parameters", undefined],
    ["a list", [CHAT, 1, 1000]],
    ["no chat", { id: 1, max_bytes: 1000 }],
    ["an empty chat", { ...ok, chat: "" }],
    ["a chat that is a number", { ...ok, chat: 123 }],
    ["no id", { chat: CHAT, max_bytes: 1000 }],
    ["an id of 0", { ...ok, id: 0 }],
    ["a negative id", { ...ok, id: -1 }],
    ["an id with a fraction", { ...ok, id: 1.5 }],
    ["an id as text", { ...ok, id: "1" }],
    ["an id past what Telegram numbers", { ...ok, id: INT32_MAX + 1 }],
    ["no limit", { chat: CHAT, id: 1 }],
    ["a limit of 0", { ...ok, max_bytes: 0 }],
    ["a negative limit", { ...ok, max_bytes: -1 }],
    ["a limit over the largest", { ...ok, max_bytes: DOWNLOAD_MAX_BYTES + 1 }],
    ["a limit with a fraction", { ...ok, max_bytes: 10.5 }],
    ["a limit as text", { ...ok, max_bytes: "1000" }],
    ["a null limit", { ...ok, max_bytes: null }],
    ["a field it does not take", { ...ok, path: "/tmp/x" }],
  ]

  for (const [name, params] of bad) {
    test(`refuses ${name}`, async () => {
      expect(await refusal(params)).toMatchObject({ code: "invalid_argument" })
      nothingAsked()
    })
  }

  test("takes the largest limit", async () => {
    const result = await download(fixture, 1, DOWNLOAD_MAX_BYTES)

    expect(result).toMatchObject({ saved: { size: 3 } })
    if ("saved" in result) rmSync(dirname(result.saved.path), { recursive: true })
  })
})

describe("a message with nothing to save", () => {
  test("is not found when the chat is not listed, and Telegram is not asked", async () => {
    const asked = fixture.client.argsOf("getMessages").length

    expect(await failureOf(download(fixture, 1, 1000, UNLISTED))).toMatchObject({ code: "not_found" })
    expect(fixture.client.argsOf("getMessages")).toHaveLength(asked)
  })

  test("is not found when the message is missing from the chat", async () => {
    expect(await failureOf(download(fixture, 99, 1000))).toMatchObject({
      code: "not_found",
      message: "No message 99 in this chat.",
    })
  })

  test("is not found when Telegram brings a message of another chat", async () => {
    fixture.client.setHistory(KEPT, mediaMessage(7, fileMedia("a.txt", "text/plain", 3)))

    expect(await failureOf(download(fixture, 7, 1000, KEPT))).toMatchObject({ code: "not_found" })
    expect(fixture.client.argsOf("downloadAsIterable")).toEqual([])
  })

  test("says what a message without media carries", async () => {
    expect(await failureOf(download(fixture, 2, 1000))).toMatchObject({
      code: "not_found",
      message: "Message 2 has no file to save; it carries only text.",
    })
  })

  for (const [name, media, carries] of [
    ["a poll", fakePollMedia(), "poll"],
    ["a die", fakeDiceMedia(), "dice"],
  ] as const) {
    test(`says ${name} is not a file`, async () => {
      fixture.client.setHistory(CHAT, mediaMessage(3, media))

      expect(await failureOf(download(fixture, 3, 1000))).toMatchObject({
        code: "not_found",
        message: `Message 3 has no file to save; it carries ${carries}.`,
      })
      expect(fixture.client.argsOf("downloadAsIterable")).toEqual([])
    })
  }
})

describe("a file meant to be seen once", () => {
  for (const [name, media] of [
    ["a view-once photo", fakeViewOncePhotoMedia()],
    ["a self-destructing photo", fakePhotoMedia({ ttlSeconds: 10 })],
    ["a self-destructing file", { ...fileMedia("a.txt", "text/plain", 3), ttlSeconds: 10 }],
  ] as const) {
    test(`is forbidden for ${name}`, async () => {
      fixture.client.setHistory(CHAT, mediaMessage(4, media))

      expect(await failureOf(download(fixture, 4, 1000))).toMatchObject({
        code: "forbidden",
        message: "This file was meant to be seen once; it is not saved.",
      })
      expect(fixture.client.argsOf("downloadAsIterable")).toEqual([])
      expect(incomingFolders(fixture)).toEqual([])
    })
  }
})

describe("a channel", () => {
  const channel = FAKE_MARKED.channel
  const post = () =>
    messageOf(
      fakeMessage({
        id: 5,
        peerId: channelPeer(FAKE_IDS.channel),
        fromId: userPeer(),
        media: fileMedia("a.txt", "text/plain", 3),
      }),
      fakeUser(),
      fakeChannel(),
    )
  const seedChannel = (f: SyncFixture) =>
    f.seed((mirror) =>
      upsertChats(mirror, [chatInput({ id: channel, kind: "channel", name: "News", username: null })], START_MS),
    )

  test("is not found with channels off, where the mirror lists none", async () => {
    const off = syncFixture()
    try {
      seedChannel(off)
      off.client.setHistory(channel, post())
      await off.running()

      expect(await failureOf(download(off, 5, 1000, channel))).toMatchObject({ code: "not_found" })
      expect(off.client.argsOf("getMessages")).toEqual([])
    } finally {
      await off.close()
    }
  })

  test("is read with channels on", async () => {
    const on = syncFixture()
    try {
      seedChannel(on)
      on.client.setHistory(channel, post())
      on.client.setDownload([Uint8Array.of(1, 2, 3)])
      await on.running({ channels: true })

      expect(await download(on, 5, 1000, channel)).toMatchObject({ saved: { size: 3, kind: "document" } })
    } finally {
      await on.close()
    }
  })
})
