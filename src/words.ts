import { mergeTranslations, type Translations } from "./core"
import { CHAT_FACT_TRANSLATIONS } from "./core/chat/facts"
import { FACT_TRANSLATIONS } from "./core/facts"
import { MESSAGE_TRANSLATIONS } from "./core/message/words"

/** The translations of every tool's words, per language, which the native plugins use in their approval prompts. */
export const ALL_TRANSLATIONS: Translations = mergeTranslations(
  FACT_TRANSLATIONS,
  CHAT_FACT_TRANSLATIONS,
  MESSAGE_TRANSLATIONS,
)
