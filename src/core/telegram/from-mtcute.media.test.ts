import { describe, expect, test } from "bun:test"
import type { tl } from "@mtcute/core"
import { fakeMessage, fakeUser, messageOf } from "./fake-telegram.testing"
import {
  fakeAudioMedia,
  fakeContactMedia,
  fakeDiceMedia,
  fakeDocumentMedia,
  fakeGeoMedia,
  fakePhotoMedia,
  fakePollMedia,
  fakeStickerMedia,
  fakeUnsupportedMedia,
  fakeVenueMedia,
  fakeVideoMedia,
  fakeViewOncePhotoMedia,
  fakeVoiceMedia,
  fakeWebPageMedia,
} from "./fake-telegram-media.testing"
import { messageInputOf } from "./from-mtcute"
import type { MessageInput } from "./mirror-input"

const alice = fakeUser()

function inputOf(media: tl.TypeMessageMedia, overrides: Partial<tl.RawMessage> = {}): MessageInput {
  const input = messageInputOf(messageOf(fakeMessage({ media, message: "caption", ...overrides }), alice))
  if (!input) throw new Error("expected a message input")
  return input
}

describe("messageInputOf media files", () => {
  test("a photo keeps its best size and the caption stays the body", () => {
    expect(inputOf(fakePhotoMedia())).toMatchObject({
      body: "caption",
      media: { type: "photo", size: 123_456, width: 800, height: 600 },
    })
  })

  test("a photo behind a spoiler says so", () => {
    expect(inputOf(fakePhotoMedia({ spoiler: true })).media).toMatchObject({ type: "photo", spoiler: true })
  })

  test("a document keeps its name, type and size", () => {
    expect(inputOf(fakeDocumentMedia()).media).toEqual({
      type: "document",
      name: "report.pdf",
      mime: "application/pdf",
      size: 20_000,
    })
  })

  test("a voice note keeps its length and has no name", () => {
    expect(inputOf(fakeVoiceMedia()).media).toEqual({ type: "voice", mime: "audio/ogg", size: 5_000, duration: 7 })
  })

  test("a track keeps its length and title", () => {
    expect(inputOf(fakeAudioMedia()).media).toEqual({
      type: "audio",
      name: "track.mp3",
      mime: "audio/mpeg",
      size: 3_400_000,
      duration: 215,
      title: "Example Track",
    })
  })

  test("a video keeps its length and dimensions", () => {
    expect(inputOf(fakeVideoMedia({ spoiler: true })).media).toEqual({
      type: "video",
      name: "clip.mp4",
      mime: "video/mp4",
      size: 987_654,
      duration: 12.5,
      width: 1280,
      height: 720,
      spoiler: true,
    })
  })

  test("a sticker keeps its emoji and dimensions", () => {
    expect(inputOf(fakeStickerMedia()).media).toEqual({
      type: "sticker",
      mime: "image/webp",
      size: 30_000,
      emoji: "😀",
      width: 512,
      height: 512,
    })
  })

  test("a die keeps its emoji", () => {
    expect(inputOf(fakeDiceMedia()).media).toEqual({ type: "dice", emoji: "🎲" })
  })
})

describe("messageInputOf media that is no file", () => {
  test("a link keeps its address and title", () => {
    expect(inputOf(fakeWebPageMedia()).media).toEqual({
      type: "webpage",
      url: "https://example.test/page",
      title: "Example Page",
    })
  })

  test("a link without a title keeps its address", () => {
    const media = fakeWebPageMedia("https://example.test/plain")
    delete (media.webpage as tl.RawWebPage).title
    expect(inputOf(media).media).toEqual({ type: "webpage", url: "https://example.test/plain" })
  })

  test("a poll keeps its question only", () => {
    expect(inputOf(fakePollMedia()).media).toEqual({ type: "poll", question: "Example question?" })
  })

  test("a place keeps its type only", () => {
    expect(inputOf(fakeGeoMedia()).media).toEqual({ type: "location" })
  })

  test("a venue keeps its title only", () => {
    expect(inputOf(fakeVenueMedia()).media).toEqual({ type: "venue", title: "Example Cafe" })
  })

  test("a contact keeps its name only", () => {
    expect(inputOf(fakeContactMedia()).media).toEqual({ type: "contact", title: "Carol Example" })
  })
})

describe("messageInputOf media mtcute cannot read", () => {
  test("is unsupported, named by Telegram's own type", () => {
    expect(inputOf(fakeUnsupportedMedia()).media).toEqual({ type: "unsupported", what: "messageMediaUnsupported" })
  })

  test("is unsupported for a photo that has no sizes", () => {
    const media = fakePhotoMedia()
    ;(media.photo as tl.RawPhoto).sizes = []
    expect(inputOf(media).media).toEqual({ type: "unsupported", what: "messageMediaPhoto" })
  })

  test("is no media for empty media", () => {
    expect(inputOf({ _: "messageMediaEmpty" }).media).toBeNull()
  })
})

describe("messageInputOf media that disappears", () => {
  test("view-once media is marked, with no timer", () => {
    expect(inputOf(fakeViewOncePhotoMedia())).toMatchObject({
      media: { type: "photo" },
      viewOnce: true,
      selfDestruct: null,
    })
  })

  test("media that lives some seconds after it is opened keeps the seconds", () => {
    expect(inputOf(fakePhotoMedia({ ttlSeconds: 10 }))).toMatchObject({ viewOnce: false, selfDestruct: 10 })
    expect(inputOf(fakeVoiceMedia({ ttlSeconds: 15 }))).toMatchObject({ viewOnce: false, selfDestruct: 15 })
    expect(inputOf(fakeVideoMedia({ ttlSeconds: 0x7fffffff }))).toMatchObject({ viewOnce: true, selfDestruct: null })
  })

  test("media without a timer is neither", () => {
    expect(inputOf(fakePhotoMedia())).toMatchObject({ viewOnce: false, selfDestruct: null })
    expect(inputOf(fakePollMedia())).toMatchObject({ viewOnce: false, selfDestruct: null })
  })

  test("a message's own timer is kept apart from the media's", () => {
    expect(inputOf(fakePhotoMedia(), { ttlPeriod: 3600 })).toMatchObject({ ttl: 3600, selfDestruct: null })
  })
})
