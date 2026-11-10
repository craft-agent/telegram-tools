import { MtcuteError, getMarkedPeerId, parsePeer } from "@mtcute/core"
import type { Message, MessageAction, Peer, PeersIndex, ReactionCount, tl } from "@mtcute/core"
import type { ActionInfo, EntityInfo, ForwardInfo, MessageInput, ReactionInfo, ReplyInfo } from "./mirror-input"

/** The prefix of a custom-emoji reaction's id, since the mirror holds a reaction as text. */
const CUSTOM_REACTION_PREFIX = "custom:"

/** Who sent a message, as the mirror records it. */
export type SenderInfo = Pick<MessageInput, "sender" | "senderName">

/** A peer's marked id as the mirror writes it: a decimal string. */
export function markedId(peer: tl.TypePeer): string {
  return String(getMarkedPeerId(peer))
}

/**
 * What a getter returns, or `null` when mtcute cannot build the object from
 * what Telegram sent (a photo without sizes, for one). Other errors are bugs
 * and pass through.
 */
export function readOrNull<T>(read: () => T): T | null {
  try {
    return read()
  } catch (error) {
    if (error instanceof MtcuteError) return null
    throw error
  }
}

/** The peer an update names, when the update brought it along. */
export function peerOf(peers: PeersIndex, peer: tl.TypePeer): Peer | null {
  return peers.has(peer) ? readOrNull(() => parsePeer(peer, peers)) : null
}

/**
 * The sender of a message and the name to show. A post of a channel or an
 * anonymous admin is sent by the chat itself, and a post signature is the name.
 * A message the account sent in a private chat names no sender, since Telegram
 * leaves it out and the chat's peer is the other side.
 */
export function senderOf(message: Message): SenderInfo {
  const { raw } = message
  const isOwnPrivate = raw.out === true && raw.fromId === undefined && raw.peerId._ === "peerUser"
  const from = isOwnPrivate ? undefined : (raw.fromId ?? raw.peerId)
  if (!from) return { sender: null, senderName: null }
  const name = message.signature ?? peerOf(message._peers, from)?.displayName
  return { sender: markedId(from), senderName: name || null }
}

/** The forum topic a message was sent to, or null (the General topic's messages carry none). */
export function topicOf(message: Message): number | null {
  return readOrNull(() => (message.isTopicMessage ? (message.replyToMessage?.threadId ?? null) : null))
}

/** The text entities of a message, without the ones mtcute cannot name. */
export function entitiesOf(message: Pick<Message, "entities">): EntityInfo[] {
  const entities: EntityInfo[] = []
  for (const entity of message.entities) {
    const { params } = entity
    if (params.kind === "unknown") continue
    const info: EntityInfo = { type: params.kind, offset: entity.offset, length: entity.length }
    if (params.kind === "text_link") info.url = params.url
    if (params.kind === "text_mention") info.user = String(params.userId)
    entities.push(info)
  }
  return entities
}

/**
 * What a message replies to. In a forum topic, a message that replies to
 * nothing else still names the topic's first message, which is no reply.
 */
export function replyOf(message: Message): ReplyInfo | null {
  const reply = readOrNull(() => message.replyToMessage)
  if (!reply) return null
  const isTopicPost = reply.isForumTopic && reply.raw.replyToTopId === undefined
  const info: ReplyInfo = {}
  if (!isTopicPost && reply.id !== null) info.id = reply.id
  if (reply.origin === "other_chat" && reply.raw.replyToPeerId) info.chat = markedId(reply.raw.replyToPeerId)
  if (!isTopicPost && reply.isForumTopic && reply.threadId !== null) info.topic = reply.threadId
  if (reply.isQuote && reply.quoteText) info.quote = reply.quoteText
  return Object.keys(info).length > 0 ? info : null
}

/** Where a message was forwarded from: the original sender's id, or only a name when it is hidden. */
export function forwardOf(message: Message): ForwardInfo | null {
  const forward = readOrNull(() => message.forward)
  if (!forward) return null
  const { raw } = forward
  const info: ForwardInfo = { date: forward.date.getTime() }
  if (raw.fromName) info.name = raw.fromName
  else if (raw.fromId) info.from = markedId(raw.fromId)
  const id = raw.channelPost ?? forward.fromMessageId
  if (id !== null && id !== undefined) info.id = id
  return info
}

/** The reactions Telegram sent; null when unknown, an empty list when explicitly cleared. */
export function reactionsOf(message: Message): ReactionInfo[] | null {
  if (message.raw._ !== "message" || message.raw.reactions === undefined) return null
  return reactionInfosOf(message.reactions?.reactions ?? [])
}

/** The reaction counts as the mirror records them; one mtcute cannot read, such as an empty one, is left out. */
export function reactionInfosOf(counts: readonly ReactionCount[]): ReactionInfo[] {
  const reactions: ReactionInfo[] = []
  for (const count of counts) {
    const info = readOrNull(() => {
      const emoji = typeof count.emoji === "string" ? count.emoji : `${CUSTOM_REACTION_PREFIX}${count.emoji.toString()}`
      const info: ReactionInfo = { emoji, count: count.count }
      if (count.order !== null) info.mine = true
      return info
    })
    if (info) reactions.push(info)
  }
  return reactions
}

function actionDetails(action: NonNullable<MessageAction>): Omit<ActionInfo, "type"> {
  switch (action.type) {
    case "chat_created":
      return { title: action.title, users: action.users.map(String) }
    case "channel_created":
    case "channel_migrate_from":
    case "title_changed":
      return { title: action.title }
    case "topic_created":
      return action.titleMissing ? {} : { title: action.title }
    case "topic_edited":
      return action.title ? { title: action.title } : {}
    case "users_added":
      return { users: action.users.map(String) }
    case "user_removed":
      return { users: [String(action.user)] }
    case "user_joined_link":
      return { users: [String(action.inviter)] }
    case "ttl_changed":
      return { period: action.period }
    default:
      return {}
  }
}

/**
 * What a service message did: its type plus the title, period and user ids it
 * names. An action mtcute does not know keeps Telegram's own name as its type.
 */
export function actionOf(message: Message): ActionInfo | null {
  const { raw } = message
  if (raw._ !== "messageService") return null
  const action = readOrNull(() => message.action)
  if (!action) return { type: raw.action._ }
  return { type: action.type, ...actionDetails(action) }
}
