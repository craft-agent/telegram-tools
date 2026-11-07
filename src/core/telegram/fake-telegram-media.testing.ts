import { Long } from "@mtcute/core"
import type { tl } from "@mtcute/core"
import {
  FAKE_ACCESS_HASH,
  FAKE_DATE,
  FAKE_DC_ID,
  FAKE_DOCUMENT_ID,
  FAKE_FILE_REFERENCE,
  FAKE_GEO,
  FAKE_PHONE,
  FAKE_PHOTO_ID,
  FAKE_VCARD,
  FAKE_VIEW_ONCE_TTL,
  type Overrides,
} from "./fake-telegram.testing"

/** A photo of 800 by 600 pixels and 123456 bytes, with a smaller preview; fields of the media to override. */
export function fakePhotoMedia(overrides: Overrides<tl.RawMessageMediaPhoto> = {}): tl.RawMessageMediaPhoto {
  return {
    _: "messageMediaPhoto",
    photo: {
      _: "photo",
      id: FAKE_PHOTO_ID,
      accessHash: FAKE_ACCESS_HASH,
      fileReference: FAKE_FILE_REFERENCE,
      date: FAKE_DATE,
      dcId: FAKE_DC_ID,
      sizes: [
        { _: "photoSize", type: "m", w: 320, h: 240, size: 9_000 },
        { _: "photoSize", type: "y", w: 800, h: 600, size: 123_456 },
      ],
    },
    ...overrides,
  }
}

/** A photo that can be opened once. */
export function fakeViewOncePhotoMedia(): tl.RawMessageMediaPhoto {
  return fakePhotoMedia({ ttlSeconds: FAKE_VIEW_ONCE_TTL })
}

function fakeFileMedia(
  mimeType: string,
  size: number,
  attributes: tl.TypeDocumentAttribute[],
  overrides: Overrides<tl.RawMessageMediaDocument>,
): tl.RawMessageMediaDocument {
  return {
    _: "messageMediaDocument",
    document: {
      _: "document",
      id: FAKE_DOCUMENT_ID,
      accessHash: FAKE_ACCESS_HASH,
      fileReference: FAKE_FILE_REFERENCE,
      date: FAKE_DATE,
      mimeType,
      size,
      dcId: FAKE_DC_ID,
      attributes,
    },
    ...overrides,
  }
}

/** A plain file: `report.pdf`, 20000 bytes. */
export function fakeDocumentMedia(overrides: Overrides<tl.RawMessageMediaDocument> = {}): tl.RawMessageMediaDocument {
  return fakeFileMedia(
    "application/pdf",
    20_000,
    [{ _: "documentAttributeFilename", fileName: "report.pdf" }],
    overrides,
  )
}

/** A voice note of 7 seconds and 5000 bytes. */
export function fakeVoiceMedia(overrides: Overrides<tl.RawMessageMediaDocument> = {}): tl.RawMessageMediaDocument {
  return fakeFileMedia("audio/ogg", 5_000, [{ _: "documentAttributeAudio", voice: true, duration: 7 }], overrides)
}

/** A music track of 215 seconds. */
export function fakeAudioMedia(overrides: Overrides<tl.RawMessageMediaDocument> = {}): tl.RawMessageMediaDocument {
  return fakeFileMedia(
    "audio/mpeg",
    3_400_000,
    [
      { _: "documentAttributeAudio", duration: 215, title: "Example Track", performer: "Example Band" },
      { _: "documentAttributeFilename", fileName: "track.mp3" },
    ],
    overrides,
  )
}

/** A video of 12.5 seconds, 1280 by 720 pixels and 987654 bytes. */
export function fakeVideoMedia(overrides: Overrides<tl.RawMessageMediaDocument> = {}): tl.RawMessageMediaDocument {
  return fakeFileMedia(
    "video/mp4",
    987_654,
    [
      { _: "documentAttributeVideo", duration: 12.5, w: 1280, h: 720 },
      { _: "documentAttributeFilename", fileName: "clip.mp4" },
    ],
    overrides,
  )
}

/** A sticker for 😀 of 512 by 512 pixels. */
export function fakeStickerMedia(overrides: Overrides<tl.RawMessageMediaDocument> = {}): tl.RawMessageMediaDocument {
  return fakeFileMedia(
    "image/webp",
    30_000,
    [
      { _: "documentAttributeSticker", alt: "😀", stickerset: { _: "inputStickerSetEmpty" } },
      { _: "documentAttributeImageSize", w: 512, h: 512 },
    ],
    overrides,
  )
}

/** A die showing 4. */
export function fakeDiceMedia(): tl.RawMessageMediaDice {
  return { _: "messageMediaDice", value: 4, emoticon: "🎲" }
}

/** A poll with two answers. */
export function fakePollMedia(question = "Example question?"): tl.RawMessageMediaPoll {
  const text = (value: string): tl.RawTextWithEntities => ({ _: "textWithEntities", text: value, entities: [] })
  return {
    _: "messageMediaPoll",
    poll: {
      _: "poll",
      id: Long.fromNumber(5_000_000_003),
      question: text(question),
      answers: [
        { _: "pollAnswer", text: text("Yes"), option: Uint8Array.of(1) },
        { _: "pollAnswer", text: text("No"), option: Uint8Array.of(2) },
      ],
      hash: Long.ZERO,
    },
    results: { _: "pollResults" },
  }
}

/** A shared place, at `FAKE_GEO`. */
export function fakeGeoMedia(): tl.RawMessageMediaGeo {
  return { _: "messageMediaGeo", geo: { _: "geoPoint", ...FAKE_GEO, accessHash: FAKE_ACCESS_HASH } }
}

/** A shared venue, at `FAKE_GEO`. */
export function fakeVenueMedia(title = "Example Cafe"): tl.RawMessageMediaVenue {
  return {
    _: "messageMediaVenue",
    geo: { _: "geoPoint", ...FAKE_GEO, accessHash: FAKE_ACCESS_HASH },
    title,
    address: "1 Example Street",
    provider: "foursquare",
    venueId: "venue-1",
    venueType: "food/cafe",
  }
}

/** A shared contact with `FAKE_PHONE`. */
export function fakeContactMedia(): tl.RawMessageMediaContact {
  return {
    _: "messageMediaContact",
    phoneNumber: FAKE_PHONE,
    firstName: "Carol",
    lastName: "Example",
    vcard: `BEGIN:VCARD\nTEL:${FAKE_PHONE}\nNOTE:${FAKE_VCARD}\nEND:VCARD`,
    userId: 0,
  }
}

/** A link preview. */
export function fakeWebPageMedia(url = "https://example.test/page", title = "Example Page"): tl.RawMessageMediaWebPage {
  return {
    _: "messageMediaWebPage",
    webpage: { _: "webPage", id: Long.fromNumber(5_000_000_004), url, displayUrl: "example.test/page", hash: 0, title },
  }
}

/** Media of a kind mtcute does not know. */
export function fakeUnsupportedMedia(): tl.RawMessageMediaUnsupported {
  return { _: "messageMediaUnsupported" }
}

export function fakeGameMedia(): tl.RawMessageMediaGame {
  return {
    _: "messageMediaGame",
    game: {
      _: "game",
      id: FAKE_DOCUMENT_ID,
      accessHash: FAKE_ACCESS_HASH,
      shortName: "example_game",
      title: "Example Game",
      description: FAKE_PHONE,
      photo: fakePhotoMedia().photo!,
      document: fakeDocumentMedia().document,
    },
  }
}

export function fakeInvoiceMedia(): tl.RawMessageMediaInvoice {
  return {
    _: "messageMediaInvoice",
    title: "Example Invoice",
    description: FAKE_PHONE,
    currency: "USD",
    totalAmount: Long.fromNumber(100),
    startParam: FAKE_VCARD,
    photo: {
      _: "webDocument",
      url: `https://example.test/${FAKE_VCARD}`,
      accessHash: FAKE_ACCESS_HASH,
      size: 123,
      mimeType: "image/jpeg",
      attributes: [],
    },
  }
}

export function fakeTodoMedia(): tl.RawMessageMediaToDo {
  return {
    _: "messageMediaToDo",
    todo: {
      _: "todoList",
      title: { _: "textWithEntities", text: "Example Tasks", entities: [] },
      list: [{ _: "todoItem", id: 1, title: { _: "textWithEntities", text: FAKE_PHONE, entities: [] } }],
    },
  }
}

export function fakeLiveLocationMedia(): tl.RawMessageMediaGeoLive {
  return { _: "messageMediaGeoLive", geo: fakeGeoMedia().geo, period: 600 }
}

export function fakeStoryMedia(): tl.RawMessageMediaStory {
  return {
    _: "messageMediaStory",
    peer: { _: "peerUser", userId: Number(FAKE_PHOTO_ID.toString()) },
    id: FAKE_DC_ID,
    story: {
      _: "storyItem",
      id: FAKE_DC_ID,
      date: FAKE_DATE,
      expireDate: FAKE_DATE + 600,
      caption: FAKE_PHONE,
      media: fakePhotoMedia(),
    },
  }
}

export function fakePaidMedia(): tl.RawMessageMediaPaidMedia {
  return {
    _: "messageMediaPaidMedia",
    starsAmount: FAKE_ACCESS_HASH,
    extendedMedia: [
      { _: "messageExtendedMedia", media: fakePhotoMedia() },
      { _: "messageExtendedMedia", media: fakeDocumentMedia() },
    ],
  }
}
