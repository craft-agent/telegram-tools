import type { Message, MessageMedia } from "@mtcute/core"
import { mediaOf } from "./from-mtcute-media"
import { readOrNull } from "./from-mtcute-parts"
import { isCount } from "./mirror-input"
import type { DeclaredFile } from "./service-requests"

const MS_PER_S = 1000

/** The kinds of media (`MediaInfo.type`) that are a file Telegram serves. */
const FILE_KINDS = ["photo", "document", "audio", "voice", "video", "sticker"] as const

/** The media of a message that is a file Telegram serves. */
export type FileMedia = Extract<NonNullable<MessageMedia>, { type: (typeof FILE_KINDS)[number] }>

/** A message's file: what to download, and what Telegram declares of it. */
export type MessageFile = { media: FileMedia; declared: DeclaredFile }

function isFileMedia(media: MessageMedia): media is FileMedia {
  return media !== null && (FILE_KINDS as readonly string[]).includes(media.type)
}

/** The file a message carries, or null when it carries none. */
export function messageFile(message: Message): MessageFile | null {
  const info = mediaOf(message)
  const media = readOrNull(() => message.media)
  if (!info || !media || !isFileMedia(media)) return null
  // A size that is no byte count (a photo whose sizes are empty) is no size.
  const size = isCount(info.size) ? info.size : null
  return { media, declared: { name: info.name ?? null, type: info.mime ?? null, size, kind: info.type } }
}

/** When the message disappears by its chat's timer, in Unix milliseconds; undefined when it has none. */
export function disappearsAtOf(message: Message): number | undefined {
  const ttl = message.ttlPeriod
  return ttl ? message.date.getTime() + ttl * MS_PER_S : undefined
}
