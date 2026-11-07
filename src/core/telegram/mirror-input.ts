/** Every kind of chat the mirror knows. */
export const CHAT_KINDS = ["user", "bot", "self", "group", "supergroup", "channel"] as const

/** What a chat is: a person, a bot, Saved Messages (`self`), a basic group, a supergroup or a channel. */
export type ChatKind = (typeof CHAT_KINDS)[number]

/**
 * The kinds whose message ids are numbered within the chat. The ids of every
 * other kind are numbered once for the whole account, so a delete that names
 * no chat can only mean one of those.
 */
export const PER_CHAT_KINDS: readonly ChatKind[] = ["supergroup", "channel"]

/** Whether `value` is a kind of chat. */
export function isChatKind(value: unknown): value is ChatKind {
  return CHAT_KINDS.includes(value as ChatKind)
}

/** Whether `value` can be a chat id: Telegram's marked id as a non-empty string. */
export function isChatId(value: unknown): value is string {
  return typeof value === "string" && value !== ""
}

/** Whether `value` can be a message or topic id, or a time: a non-negative safe integer. */
export function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

/**
 * A chat as the dialog list or a peer describes it. An optional field that is
 * absent leaves the stored value as it is; `topId`, `lastTs` and `readMax`
 * only ever grow the stored value.
 */
export type ChatInput = {
  id: string
  kind: ChatKind
  name: string | null
  username: string | null
  /** A supergroup with topics. */
  forum?: boolean
  /** Left, removed, banned, deactivated, or private now. */
  left?: boolean
  /** `null`: not known. */
  canSend?: boolean | null
  archived?: boolean
  unread?: number
  /** Incoming messages are read up to this id. */
  readMax?: number | null
  /** The newest known message's id. */
  topId?: number | null
  /** The newest known message's time. */
  lastTs?: number | null
  /** The chat's auto-delete period in seconds; `null`: none. */
  ttl?: number | null
}

/** A text entity of a message: a link, mention, code span and the like. Only what a reader needs. */
export type EntityInfo = {
  type: string
  offset: number
  length: number
  /** The target of a text link. */
  url?: string
  /** The marked id of a mentioned user. */
  user?: string
}

/** A short summary of a message's media: a file's facts, or for a non-file kind a line about it. */
export type MediaInfo = {
  type: string
  name?: string
  mime?: string
  size?: number
  duration?: number
  width?: number
  height?: number
  emoji?: string
  spoiler?: true
  title?: string
  url?: string
  question?: string
  what?: string
}

/** What a service message did: its type plus the few small fields that say what changed. */
export type ActionInfo = {
  type: string
  title?: string
  /** An auto-delete period in seconds. */
  period?: number
  /** Marked ids of the users it names. */
  users?: string[]
}

/** What a message replies to. */
export type ReplyInfo = {
  id?: number
  /** The chat of the replied-to message, when it is another chat. */
  chat?: string
  topic?: number
  quote?: string
}

/** Where a message was forwarded from. */
export type ForwardInfo = {
  /** The marked id of the original sender or chat. */
  from?: string
  /** The sender's name, when only a name is given. */
  name?: string
  date?: number
  id?: number
}

/** One reaction on a message. */
export type ReactionInfo = {
  emoji: string
  count: number
  /** Set when the account itself reacted. */
  mine?: true
}

/**
 * A message in full; an edit is the same message with `edited` set. Times are
 * Unix milliseconds, `ttl` and `selfDestruct` seconds.
 */
export type MessageInput = {
  chat: string
  id: number
  /** The forum topic's id. */
  topic: number | null
  ts: number
  fromMe: boolean
  /** The marked id of the sender. */
  sender: string | null
  senderName: string | null
  kind: "message" | "service"
  /** Text, or the caption of media. */
  body: string | null
  entities: EntityInfo[]
  media: MediaInfo | null
  action: ActionInfo | null
  reply: ReplyInfo | null
  forward: ForwardInfo | null
  /** The album's id, as text. */
  grouped: string | null
  /** `null`: not known in this input, so the stored ones stay. */
  reactions: ReactionInfo[] | null
  /** When this version was made, if it was edited. */
  edited: number | null
  /** The auto-delete period in seconds. */
  ttl: number | null
  viewOnce: boolean
  /** Seconds the media lives after it is opened, for a self-destructing one that is not view-once. */
  selfDestruct: number | null
}

/** Messages deleted for everyone; `chat` is `null` when the update names none (private chats and basic groups). */
export type DeleteInput = { chat: string | null; ids: number[] }

/** The user read a chat up to `maxId` on another device; `unread` is what is left, when known. */
export type ReadInput = { chat: string; maxId: number; unread: number | null }

/** A forum topic. An optional field that is absent leaves the stored value as it is. */
export type TopicInput = { chat: string; id: number; title?: string | null; closed?: boolean }

/** What ingesting needs to know about the moment and the settings. */
export type IngestContext = {
  /** When the input arrived, in milliseconds. */
  now: number
  /** Whether `keep_disappearing` is on: messages that disappear are kept. */
  keepDisappearing: boolean
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean"
}

function isPositiveId(value: unknown): value is number {
  return isCount(value) && value > 0
}

function nullable(value: unknown, guard: (value: unknown) => boolean): boolean {
  return value === null || guard(value)
}

function optional(value: unknown, guard: (value: unknown) => boolean): boolean {
  return value === undefined || guard(value)
}

function isEntity(value: unknown): boolean {
  return (
    isObject(value) &&
    isString(value.type) &&
    isCount(value.offset) &&
    isCount(value.length) &&
    optional(value.url, isString) &&
    optional(value.user, isChatId)
  )
}

function isMedia(value: unknown): boolean {
  return (
    isObject(value) &&
    isString(value.type) &&
    ["name", "mime", "emoji", "title", "url", "question", "what"].every((key) => optional(value[key], isString)) &&
    ["size", "duration", "width", "height"].every((key) => optional(value[key], isCount)) &&
    optional(value.spoiler, (flag) => flag === true)
  )
}

function isAction(value: unknown): boolean {
  return (
    isObject(value) &&
    isString(value.type) &&
    optional(value.title, isString) &&
    optional(value.period, isCount) &&
    optional(value.users, (users) => Array.isArray(users) && users.every(isChatId))
  )
}

function isReply(value: unknown): boolean {
  return (
    isObject(value) &&
    optional(value.id, isPositiveId) &&
    optional(value.chat, isChatId) &&
    optional(value.topic, isPositiveId) &&
    optional(value.quote, isString)
  )
}

function isForward(value: unknown): boolean {
  return (
    isObject(value) &&
    optional(value.from, isChatId) &&
    optional(value.name, isString) &&
    optional(value.date, isCount) &&
    optional(value.id, isPositiveId)
  )
}

function isReaction(value: unknown): boolean {
  return (
    isObject(value) && isString(value.emoji) && isCount(value.count) && optional(value.mine, (flag) => flag === true)
  )
}

/** Whether every field is safe to store as a message. */
export function isMessageInput(value: unknown): value is MessageInput {
  return (
    isObject(value) &&
    isChatId(value.chat) &&
    isPositiveId(value.id) &&
    nullable(value.topic, isPositiveId) &&
    isCount(value.ts) &&
    isBoolean(value.fromMe) &&
    nullable(value.sender, isString) &&
    nullable(value.senderName, isString) &&
    (value.kind === "message" || value.kind === "service") &&
    nullable(value.body, isString) &&
    Array.isArray(value.entities) &&
    value.entities.every(isEntity) &&
    nullable(value.media, isMedia) &&
    nullable(value.action, isAction) &&
    nullable(value.reply, isReply) &&
    nullable(value.forward, isForward) &&
    nullable(value.grouped, isString) &&
    nullable(value.reactions, (reactions) => Array.isArray(reactions) && reactions.every(isReaction)) &&
    nullable(value.edited, isCount) &&
    nullable(value.ttl, isCount) &&
    isBoolean(value.viewOnce) &&
    nullable(value.selfDestruct, isCount)
  )
}

/** Whether every field is safe to store as a chat. */
export function isChatInput(value: unknown): value is ChatInput {
  return (
    isObject(value) &&
    isChatId(value.id) &&
    isChatKind(value.kind) &&
    nullable(value.name, isString) &&
    nullable(value.username, isString) &&
    ["forum", "left", "archived"].every((key) => optional(value[key], isBoolean)) &&
    optional(value.canSend, (flag) => nullable(flag, isBoolean)) &&
    optional(value.unread, isCount) &&
    ["readMax", "topId"].every((key) => optional(value[key], (id) => nullable(id, isPositiveId))) &&
    ["lastTs", "ttl"].every((key) => optional(value[key], (count) => nullable(count, isCount)))
  )
}

/** Whether every field is safe to store as a topic. */
export function isTopicInput(value: unknown): value is TopicInput {
  return (
    isObject(value) &&
    isChatId(value.chat) &&
    isPositiveId(value.id) &&
    optional(value.title, (title) => nullable(title, isString)) &&
    optional(value.closed, isBoolean)
  )
}

/** Whether every field is safe to apply as a read update. */
export function isReadInput(value: unknown): value is ReadInput {
  return isObject(value) && isChatId(value.chat) && isPositiveId(value.maxId) && nullable(value.unread, isCount)
}
