import type { ChatKind } from "../telegram/mirror-input"
import type { CallFact } from "../tool"
import type { Translations } from "../words"

/** The word of the tool's for each kind of chat, as the `Chat` fact shows it. */
export const CHAT_KIND_WORDS: Readonly<Record<ChatKind, string>> = {
  user: "Person",
  bot: "Bot",
  self: "Saved Messages",
  group: "Group",
  supergroup: "Supergroup",
  channel: "Channel",
}

/** The `Chat` fact: the kind of chat a call writes to, as a word of the tool's that the entry point translates. */
export function chatFact(kind: ChatKind): CallFact {
  return { label: "Chat", value: { text: CHAT_KIND_WORDS[kind] } }
}

/** The translations of the label and the kind words of the fact above. */
export const CHAT_FACT_TRANSLATIONS: Translations = {
  ja: {
    Chat: "チャット",
    Person: "個人",
    Bot: "ボット",
    "Saved Messages": "保存済みメッセージ",
    Group: "グループ",
    Supergroup: "スーパーグループ",
    Channel: "チャンネル",
  },
}
