import type {
  Chat,
  ChatType,
  DeleteMessageUpdate,
  Dialog,
  ForumTopic,
  HistoryReadUpdate,
  Message,
  Peer,
} from "@mtcute/core"
import { mediaOf, mediaTimerOf } from "./from-mtcute-media"
import {
  actionOf,
  entitiesOf,
  forwardOf,
  markedId,
  peerOf,
  reactionsOf,
  readOrNull,
  replyOf,
  senderOf,
  topicOf,
} from "./from-mtcute-parts"
import type { ChatInput, ChatKind, DeleteInput, MessageInput, ReadInput, TopicInput } from "./mirror-input"

/** The kinds of group chat the mirror keeps; monoforums and communities are left out. */
const CHAT_KIND_BY_TYPE: Partial<Record<ChatType, ChatKind>> = {
  group: "group",
  supergroup: "supergroup",
  gigagroup: "supergroup",
  channel: "channel",
}

function chatKindOf(chat: Chat): ChatKind | null {
  return CHAT_KIND_BY_TYPE[chat.chatType] ?? null
}

/** Whether Telegram says the account is out of a group or channel: left, removed, banned or deactivated. */
function isGone(chat: Chat): boolean {
  const deactivated = chat.raw._ === "chat" && chat.raw.deactivated === true
  return chat.isBanned || !chat.isMember || deactivated
}

/**
 * The chat a peer is: a person, a bot, Saved Messages (`self`), or a group.
 * Null for what the mirror does not keep (monoforums and communities). The
 * name is the display name or title; a peer that is only a stub (`isMin`)
 * says nothing about whether the account left, so `left` stays out.
 */
export function chatInputOf(peer: Peer): ChatInput | null {
  if (peer.type === "user") {
    const kind = peer.isSelf ? "self" : peer.isBot ? "bot" : "user"
    return { id: String(peer.id), kind, name: peer.displayName, username: peer.username }
  }
  const kind = chatKindOf(peer)
  if (!kind) return null
  const input: ChatInput = {
    id: String(peer.id),
    kind,
    name: peer.title,
    username: peer.username,
    forum: Boolean(peer.isForum),
  }
  if (!peer.isMin) input.left = isGone(peer)
  return input
}

/**
 * A chat as the dialog list shows it: the peer plus archive state, unread
 * count, the incoming read position, the newest message and the auto-delete
 * period (`null` when the dialog has none). Null for what the mirror does not keep.
 */
export function chatInputOfDialog(dialog: Dialog): ChatInput | null {
  const peer = readOrNull(() => dialog.peer)
  const input = peer ? chatInputOf(peer) : null
  if (!input) return null
  const { topMessage } = dialog.raw
  return {
    ...input,
    archived: dialog.isArchived,
    unread: dialog.unreadCount,
    readMax: dialog.lastReadIngoing,
    topId: topMessage > 0 ? topMessage : null,
    lastTs: dialog.lastMessage?.date.getTime() ?? null,
    ttl: dialog.ttlPeriod,
  }
}

/**
 * A message in full, or null when its chat is one the mirror does not keep.
 * Only what the mirror stores is copied: a file's facts, never its id,
 * reference or access hash; no coordinates and no phone numbers (see `mediaOf`).
 */
export function messageInputOf(message: Message): MessageInput | null {
  const { raw } = message
  const chat = peerOf(message._peers, raw.peerId)
  if (!chat || (chat.type === "chat" && !chatKindOf(chat))) return null
  const { sender, senderName } = senderOf(message)
  const { viewOnce, selfDestruct } = mediaTimerOf(message)
  return {
    chat: markedId(raw.peerId),
    id: message.id,
    topic: topicOf(message),
    ts: message.date.getTime(),
    fromMe: Boolean(message.isOutgoing),
    sender,
    senderName,
    kind: message.isService ? "service" : "message",
    body: message.text || null,
    entities: entitiesOf(message),
    media: mediaOf(message),
    action: actionOf(message),
    reply: replyOf(message),
    forward: forwardOf(message),
    grouped: message.groupedId?.toString() ?? null,
    reactions: reactionsOf(message),
    edited: message.editDate?.getTime() ?? null,
    ttl: message.ttlPeriod,
    viewOnce,
    selfDestruct,
  }
}

/** A delete for everyone; the chat is named only for supergroups and channels. */
export function deleteInputOf(update: DeleteMessageUpdate): DeleteInput {
  const { channelId } = update
  return { chat: channelId === null ? null : String(channelId), ids: [...update.messageIds] }
}

/**
 * The account read a chat on another device. Null for what the mirror does
 * not track: a read of the account's own messages, of a thread or topic, or of
 * a monoforum.
 */
export function readInputOf(update: HistoryReadUpdate): ReadInput | null {
  if (update.isOutbox || update.isDiscussion || update.isMonoForum || update.threadId !== 0) return null
  return { chat: String(update.chatId), maxId: update.maxReadId, unread: update.unreadCount }
}

/** A forum topic from the topic list. */
export function topicInputOf(topic: ForumTopic): TopicInput {
  return {
    chat: markedId(topic.raw.peer),
    id: topic.id,
    title: topic.titleMissing ? null : topic.title,
    closed: Boolean(topic.isClosed),
  }
}

/**
 * The topic a service message created or edited, or null for any other
 * message. A new topic whose title Telegram says is missing has a `null`
 * title. An edit names the topic by the message's reply and carries only what
 * it changed, so an edit that changes neither the title nor whether the topic
 * is closed gives null. Fields absent from an edit leave stored values alone.
 */
export function topicInputOfAction(message: Message): TopicInput | null {
  const action = readOrNull(() => message.action)
  const chat = markedId(message.raw.peerId)
  if (action?.type === "topic_created") {
    return { chat, id: message.id, title: action.titleMissing ? null : action.title, closed: false }
  }
  if (action?.type === "topic_edited") {
    const reply = readOrNull(() => message.replyToMessage)
    const id = reply?.threadId ?? reply?.id ?? null
    if (id === null || (action.title === undefined && action.closed === undefined)) return null
    const input: TopicInput = { chat, id }
    if (action.title !== undefined) input.title = action.title
    if (action.closed !== undefined) input.closed = action.closed
    return input
  }
  return null
}
