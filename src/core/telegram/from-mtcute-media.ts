import type { Message, MessageMedia, tl } from "@mtcute/core"
import { readOrNull } from "./from-mtcute-parts"
import type { MediaInfo, MessageInput } from "./mirror-input"

/** The `ttlSeconds` Telegram gives media that can be opened once. */
export const VIEW_ONCE_TTL_SECONDS = 0x7fffffff

/** The type of every photo: Telegram stores a photo as JPEG, and mtcute gives a photo no type of its own. */
export const PHOTO_MIME = "image/jpeg"

/** How a message's media disappears: opened once, or some seconds after it is opened. */
export type MediaTimer = Pick<MessageInput, "viewOnce" | "selfDestruct">

/** A media summary being put together; a field that is null or empty is left out of the result. */
type Draft = Pick<MediaInfo, "type"> & { [K in Exclude<keyof MediaInfo, "type">]?: MediaInfo[K] | null }

/** The kinds of media that are a file of their own. */
type FileMedia = Extract<NonNullable<MessageMedia>, { type: "document" | "audio" | "voice" | "video" | "sticker" }>

function rawMediaOf(message: Message): tl.TypeMessageMedia | null {
  const { raw } = message
  if (raw._ !== "message" || !raw.media || raw.media._ === "messageMediaEmpty") return null
  return raw.media
}

/** The raw media kinds that carry the timer and the spoiler flag. */
function isFileEnvelope(raw: tl.TypeMessageMedia): raw is tl.RawMessageMediaPhoto | tl.RawMessageMediaDocument {
  return raw._ === "messageMediaPhoto" || raw._ === "messageMediaDocument"
}

function fileFacts(media: FileMedia): Draft {
  return { type: media.type, name: media.fileName, mime: media.mimeType, size: media.fileSize }
}

/** A length in whole seconds: mtcute reads a video's as a fraction, and one that is no length is left out. */
function wholeSeconds(seconds: number): number | null {
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds) : null
}

function draftOf(media: NonNullable<MessageMedia>): Draft {
  switch (media.type) {
    case "photo":
      return { type: "photo", mime: PHOTO_MIME, size: media.fileSize, width: media.width, height: media.height }
    case "document":
      return fileFacts(media)
    case "audio":
      return { ...fileFacts(media), duration: wholeSeconds(media.duration), title: media.title }
    case "voice":
      return { ...fileFacts(media), duration: wholeSeconds(media.duration) }
    case "video":
      return { ...fileFacts(media), duration: wholeSeconds(media.duration), width: media.width, height: media.height }
    case "sticker":
      return { ...fileFacts(media), emoji: media.emoji, width: media.width, height: media.height }
    case "dice":
      return { type: "dice", emoji: media.emoji }
    case "contact":
      return { type: "contact", title: `${media.firstName} ${media.lastName}`.trim() }
    case "venue":
    case "game":
    case "invoice":
      return { type: media.type, title: media.title }
    case "webpage":
      return { type: "webpage", url: media.preview.url, title: media.preview.title }
    case "poll":
      return { type: "poll", question: media.question }
    case "todo":
      return { type: "todo", title: media.title.text }
    default:
      return { type: media.type }
  }
}

function present(draft: Draft): MediaInfo {
  const kept = Object.entries(draft).filter(([, value]) => value !== null && value !== undefined && value !== "")
  return Object.fromEntries(kept) as MediaInfo
}

/**
 * A short summary of a message's media, or null when it has none. A file
 * keeps its facts (name, type, size, length, dimensions); any other kind keeps
 * one line only: a link's address and title, a venue's or contact's name, a
 * poll's question. Locations never keep coordinates, contacts never keep the
 * phone number, and nothing keeps a file id, file reference or access hash.
 * Media mtcute cannot read is `unsupported`, named by Telegram's own type.
 */
export function mediaOf(message: Message): MediaInfo | null {
  const raw = rawMediaOf(message)
  if (!raw) return null
  const media = readOrNull(() => message.media)
  if (!media) return { type: "unsupported", what: raw._ }
  const spoiler = isFileEnvelope(raw) && raw.spoiler === true
  return present({ ...draftOf(media), spoiler: spoiler ? true : null })
}

/** Whether the media can be opened once, or lives some seconds after being opened. */
export function mediaTimerOf(message: Message): MediaTimer {
  const raw = rawMediaOf(message)
  const seconds = raw && isFileEnvelope(raw) ? raw.ttlSeconds : undefined
  if (!seconds) return { viewOnce: false, selfDestruct: null }
  return seconds === VIEW_ONCE_TTL_SECONDS
    ? { viewOnce: true, selfDestruct: null }
    : { viewOnce: false, selfDestruct: seconds }
}
