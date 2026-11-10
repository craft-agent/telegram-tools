import { describe, expect, test } from "bun:test"
import { translator } from "./core"
import { templatePlaceholders } from "./core/describe"
import { CHAT_FACT_TRANSLATIONS } from "./core/chat/facts"
import { FACT_TRANSLATIONS } from "./core/facts"
import { FILE_SEND_TRANSLATIONS } from "./core/file/send/words"
import { FILE_TRANSLATIONS } from "./core/file/words"
import { ACTION_TRANSLATIONS } from "./core/message/action-words"
import { MESSAGE_TRANSLATIONS } from "./core/message/words"
import { SYNC_TRANSLATIONS } from "./core/sync/words"
import { ALL_TOOLS } from "./tools"
import { ALL_TRANSLATIONS } from "./words"

const TABLES = [
  FACT_TRANSLATIONS,
  CHAT_FACT_TRANSLATIONS,
  MESSAGE_TRANSLATIONS,
  ACTION_TRANSLATIONS,
  FILE_TRANSLATIONS,
  FILE_SEND_TRANSLATIONS,
  SYNC_TRANSLATIONS,
]
const ja = ALL_TRANSLATIONS.ja!

describe("ALL_TRANSLATIONS", () => {
  test("is exactly the union of the tables, no key lost or overridden", () => {
    const keys = TABLES.flatMap((table) => Object.keys(table.ja!))
    expect(new Set(keys).size).toBe(keys.length)
    expect(ja).toEqual(Object.assign({}, ...TABLES.map((table) => table.ja)))
  })

  test("gives every write tool an intent and a description, and translates its title and intent", () => {
    const writes = ALL_TOOLS.filter((tool) => tool.class !== "read")
    expect(writes.length).toBeGreaterThan(0)
    for (const tool of writes) {
      expect(tool.intent).toBeDefined()
      expect(tool.describe).toBeDefined()
      expect(ja[tool.title]).toBeDefined()
      expect(ja[tool.intent!]).toBeDefined()
    }
  })

  test("keeps the placeholders of every template in its translation", () => {
    const translate = translator(ALL_TRANSLATIONS, "ja")
    const templates = Object.keys(ja).filter((key) => (templatePlaceholders(key)?.size ?? 0) > 0)
    expect(templates.length).toBeGreaterThan(0)
    for (const key of templates) expect(translate.template(key)).toBe(ja[key]!)
  })

  test("holds no blank translation", () => {
    for (const value of Object.values(ja)) expect(value.trim()).not.toBe("")
  })
})
