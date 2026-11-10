import type { CallFact } from "../tool"

/** The `Topic` fact of a call that names a topic: its title, or the id when the mirror has no title. */
export function topicFacts(topic: number | undefined, title: string | undefined): CallFact[] {
  return topic === undefined ? [] : [{ label: "Topic", value: title ?? String(topic) }]
}

/** The `Reply to` fact of a call that replies to a message. */
export function replyFacts(replyTo: number | undefined): CallFact[] {
  return replyTo === undefined ? [] : [{ label: "Reply to", value: { text: "message {id}", values: { id: replyTo } } }]
}
