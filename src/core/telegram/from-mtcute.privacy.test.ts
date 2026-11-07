import { describe, expect, test } from "bun:test"
import type { MessageMediaType, tl } from "@mtcute/core"
import { FAKE_PRIVATE_VALUES, fakeMessage, fakeUser, messageOf } from "./fake-telegram.testing"
import {
  fakeAudioMedia,
  fakeContactMedia,
  fakeDiceMedia,
  fakeDocumentMedia,
  fakeGameMedia,
  fakeGeoMedia,
  fakeInvoiceMedia,
  fakeLiveLocationMedia,
  fakePaidMedia,
  fakePhotoMedia,
  fakePollMedia,
  fakeStickerMedia,
  fakeStoryMedia,
  fakeTodoMedia,
  fakeUnsupportedMedia,
  fakeVenueMedia,
  fakeVideoMedia,
  fakeViewOncePhotoMedia,
  fakeVoiceMedia,
  fakeWebPageMedia,
} from "./fake-telegram-media.testing"
import { messageInputOf } from "./from-mtcute"
import type { MediaInfo } from "./mirror-input"

const ALLOWED_KEYS: readonly string[] = [
  "type",
  "name",
  "mime",
  "size",
  "duration",
  "width",
  "height",
  "emoji",
  "spoiler",
  "title",
  "url",
  "question",
  "what",
] satisfies (keyof MediaInfo)[]

/** Exhaustive against mtcute's highlevel/types/messages/message-media.d.ts union. */
const MEDIA_BUILDERS = {
  photo: fakePhotoMedia,
  document: fakeDocumentMedia,
  audio: fakeAudioMedia,
  voice: fakeVoiceMedia,
  video: fakeVideoMedia,
  sticker: fakeStickerMedia,
  dice: fakeDiceMedia,
  contact: fakeContactMedia,
  location: fakeGeoMedia,
  live_location: fakeLiveLocationMedia,
  game: fakeGameMedia,
  webpage: fakeWebPageMedia,
  venue: fakeVenueMedia,
  poll: fakePollMedia,
  invoice: fakeInvoiceMedia,
  story: fakeStoryMedia,
  paid: fakePaidMedia,
  todo: fakeTodoMedia,
} satisfies Record<MessageMediaType, () => tl.TypeMessageMedia>

const alice = fakeUser()

describe("messageInputOf keeps private values out", () => {
  const cases = [
    ...Object.entries(MEDIA_BUILDERS).map(([type, build]) => ({ type, media: build() })),
    { type: "photo", media: fakeViewOncePhotoMedia() },
    { type: "unsupported", media: fakeUnsupportedMedia() },
  ]

  for (const { type, media } of cases) {
    test(`${media._} (${type}) keeps only allowed facts and no private sentinels`, () => {
      const input = messageInputOf(messageOf(fakeMessage({ media }), alice))
      expect(input?.media?.type).toBe(type)
      for (const key of Object.keys(input!.media!)) expect(ALLOWED_KEYS).toContain(key)
      const text = JSON.stringify(input)
      for (const value of FAKE_PRIVATE_VALUES) expect(text).not.toContain(value)
    })
  }

  test("no encoded file id or unique id appears for any file kind", () => {
    for (const build of [
      fakePhotoMedia,
      fakeDocumentMedia,
      fakeAudioMedia,
      fakeVoiceMedia,
      fakeVideoMedia,
      fakeStickerMedia,
    ]) {
      const message = messageOf(fakeMessage({ media: build() }), alice)
      const file = message.media
      if (!file || !("fileId" in file)) throw new Error("expected a file")
      const text = JSON.stringify(messageInputOf(message))
      expect(file.fileId.length).toBeGreaterThan(20)
      expect(text).not.toContain(file.fileId)
      expect(text).not.toContain(file.uniqueFileId)
    }
  })
})
