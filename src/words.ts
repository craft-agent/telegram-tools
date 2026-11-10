import { mergeTranslations, type Translations } from "./core"
import { CHAT_FACT_TRANSLATIONS } from "./core/chat/facts"
import { FACT_TRANSLATIONS } from "./core/facts"
import { FILE_SEND_TRANSLATIONS } from "./core/file/send/words"
import { FILE_TRANSLATIONS } from "./core/file/words"
import { MESSAGE_TRANSLATIONS } from "./core/message/words"
import { SYNC_TRANSLATIONS } from "./core/sync/words"

/** The translations of every tool's words, per language, which the native plugins use in their approval prompts. */
export const ALL_TRANSLATIONS: Translations = mergeTranslations(
  FACT_TRANSLATIONS,
  CHAT_FACT_TRANSLATIONS,
  MESSAGE_TRANSLATIONS,
  FILE_TRANSLATIONS,
  FILE_SEND_TRANSLATIONS,
  SYNC_TRANSLATIONS,
)
