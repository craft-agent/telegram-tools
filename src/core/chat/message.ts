import { cutText } from "../pages"
import type { Mirror } from "../telegram/mirror"
import type { ActionInfo, EntityInfo, ForwardInfo, MediaInfo, ReactionInfo, ReplyInfo } from "../telegram/mirror-input"
import { isRecord } from "../telegram/service-errors"
import { formatLocalTime } from "../time"
import { PRIVATE_NOTE, type MessageEntry } from "./message-schema"
import {
  loadRelated,
  messageKey,
  pageTexts,
  readJson,
  readList,
  type MessageRef,
  type RepliedText,
  type Related,
  type StoredMessage,
  type StoredVersion,
} from "./message-rows"

/** What a message says its sender is when it is the user's own. */
const OWN_NAME = "me"

/** What a message says its sender is when nothing names them. */
const UNKNOWN_NAME = "unknown"

/** The most characters of the text of the message replied to that a result carries. */
const REPLY_TEXT_LENGTH = 200

/** A stored message with its JSON columns read. */
type Parsed = {
  row: StoredMessage
  entities: EntityInfo[]
  media: MediaInfo | null
  action: ActionInfo | null
  reply: ReplyInfo | null
  forward: ForwardInfo | null
  reactions: ReactionInfo[]
}

function readObject<T extends object>(json: string | null): T | null {
  const value = readJson(json)
  return isRecord(value) ? (value as T) : null
}

function parse(row: StoredMessage): Parsed {
  return {
    row,
    entities: readList<EntityInfo>(row.entities),
    media: readObject<MediaInfo>(row.media),
    action: readObject<ActionInfo>(row.action),
    reply: readObject<ReplyInfo>(row.reply),
    forward: readObject<ForwardInfo>(row.forward),
    reactions: readList<ReactionInfo>(row.reactions),
  }
}

/** The message a reply points at: in the reply's own chat when it names one, else the replying message's. */
function repliedRef({ row, reply }: Parsed): MessageRef | null {
  return reply?.id === undefined ? null : { chat: reply.chat ?? row.chat, id: reply.id }
}

/** The text of the message a reply points at, when a read may show it. */
function repliedText(parsed: Parsed, related: Related): RepliedText | undefined {
  const ref = repliedRef(parsed)
  return ref ? related.replied.get(messageKey(ref.chat, ref.id)) : undefined
}

/** Who sent a message: the user, else the name sent with it, else the sender's chat name, else the chat's own for a post. */
function senderName({ row }: Parsed, related: Related): string {
  if (row.from_me) return OWN_NAME
  const sender = row.sender === null ? undefined : related.chats.get(row.sender)
  const chat = related.chats.get(row.chat)
  return row.sender_name ?? sender?.name ?? (chat?.kind === "channel" ? chat.name : null) ?? UNKNOWN_NAME
}

/** The text links of a message: the words each covers (UTF-16 offsets, as a JavaScript string counts) and where it leads. */
function links({ row, entities }: Parsed): NonNullable<MessageEntry["links"]> {
  const body = row.body ?? ""
  return entities
    .filter((entity) => entity.url !== undefined)
    .map((entity) => ({ text: body.slice(entity.offset, entity.offset + entity.length), url: entity.url! }))
}

function replyTo(parsed: Parsed, related: Related): MessageEntry["reply_to"] {
  const { reply } = parsed
  if (!reply) return undefined
  const entry: NonNullable<MessageEntry["reply_to"]> = {}
  if (reply.id !== undefined) entry.id = reply.id
  if (reply.chat !== undefined) entry.chat = reply.chat
  if (reply.topic !== undefined) entry.topic = reply.topic
  if (reply.quote !== undefined) entry.quote = reply.quote
  const text = repliedText(parsed, related)?.text
  if (text !== undefined) {
    entry.text = cutText(text, REPLY_TEXT_LENGTH)
    if (entry.text.length < text.length) entry.text_cut = true
  }
  return entry
}

function forwardedFrom({ forward }: Parsed, related: Related): MessageEntry["forwarded_from"] {
  if (!forward) return undefined
  const entry: NonNullable<MessageEntry["forwarded_from"]> = {}
  if (forward.from !== undefined) entry.id = forward.from
  const name = forward.name ?? (forward.from === undefined ? null : related.chats.get(forward.from)?.name)
  if (name) entry.name = name
  if (forward.date !== undefined) entry.time = formatLocalTime(forward.date)
  return entry
}

function earlierVersions(versions: readonly StoredVersion[] | undefined): MessageEntry["earlier_versions"] {
  return versions?.map(({ at, body, media }) => {
    const version: NonNullable<MessageEntry["earlier_versions"]>[number] = { time: formatLocalTime(at) }
    if (body) version.text = body
    const stored = readObject<MediaInfo>(media)
    if (stored) version.media = stored
    return version
  })
}

function entryOf(parsed: Parsed, related: Related, now: number): MessageEntry {
  const { row, media, action, forward, reactions } = parsed
  const entry: MessageEntry = { id: row.id, time: formatLocalTime(row.ts), from: senderName(parsed, related) }
  if (!row.from_me && row.sender !== null) entry.from_id = row.sender
  if (row.topic !== null) entry.topic = row.topic
  if (row.body) entry.text = row.body
  const linked = links(parsed)
  if (linked.length > 0) entry.links = linked
  if (media) entry.media = media
  const reply = replyTo(parsed, related)
  if (reply) entry.reply_to = reply
  if (forward) entry.forwarded_from = forwardedFrom(parsed, related)
  if (row.grouped !== null) entry.album = row.grouped
  if (row.edited !== null) entry.edited_at = formatLocalTime(row.edited)
  const versions = earlierVersions(related.versions.get(messageKey(row.chat, row.id)))
  if (versions) entry.earlier_versions = versions
  if (reactions.length > 0) entry.reactions = reactions
  if (row.kind === "service" && action) entry.event = action
  if (row.expires !== null) {
    if (row.expires > now) entry.disappears_at = formatLocalTime(row.expires)
    else entry.expired = true
  }
  if (row.view_once) entry.view_once = true
  if (row.self_destruct) entry.self_destruct_seconds = row.self_destruct
  const quotesPrivate = repliedText(parsed, related)?.private === true
  if (row.expires !== null || row.view_once || row.self_destruct || quotesPrivate) entry.private_note = PRIVATE_NOTE
  return entry
}

/**
 * The entries for stored messages, in the order given. The names of the chats
 * and senders, the earlier versions and the replied-to texts of all of them
 * are read in a few queries; a replied-to text is taken from `rows` themselves
 * first, then from the mirror, so rows the mirror does not hold (a live read)
 * still find it. `now` decides which timed messages have expired (only kept
 * ones can still be shown) and which replied-to texts may be shown.
 *
 * Nothing is read of an `excluded` chat for a message that points at it: no
 * name for a sender or a forward, no text for a reply. What the message itself
 * carries (ids, the quote, the names it was stored with) stays.
 */
export function messageEntries(
  mirror: Mirror,
  rows: readonly StoredMessage[],
  now: number,
  excluded: ReadonlySet<string>,
): MessageEntry[] {
  const parsed = rows.map(parse)
  const named = parsed
    .flatMap(({ row, forward }) => [row.sender, forward?.from].filter((id) => id != null))
    .filter((id) => !excluded.has(id))
  const replies = parsed.flatMap((item) => repliedRef(item) ?? []).filter(({ chat }) => !excluded.has(chat))
  const loaded = loadRelated(mirror, rows, named, replies, now)
  const pageRows = rows.filter((row) => !excluded.has(row.chat))
  const related: Related = { ...loaded, replied: new Map([...loaded.replied, ...pageTexts(pageRows, now)]) }
  return parsed.map((item) => entryOf(item, related, now))
}
