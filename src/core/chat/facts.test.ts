import { describe, expect, test } from "bun:test"
import { callDescription } from "../describe"
import { CHAT_KINDS } from "../telegram/mirror-input"
import { DOWNLOAD_CONTEXT } from "../tool.testing"
import { CHAT_FACT_TRANSLATIONS, CHAT_KIND_WORDS, chatFact } from "./facts"

describe("chatFact", () => {
  test.each(CHAT_KINDS)("gives the %s kind as a value template without placeholders", (kind) => {
    expect(chatFact(kind)).toEqual({ label: "Chat", value: { text: CHAT_KIND_WORDS[kind] } })
  })

  test("is kept by a description as a template", async () => {
    const spec = {
      input: { strict: () => ({ safeParse: (value: unknown) => ({ success: true, data: value }) }) },
      describe: () => ({ facts: [chatFact("supergroup")] }),
    }
    const description = await callDescription(spec as never, {}, { cwd: "/work", ...DOWNLOAD_CONTEXT })
    expect(description?.facts).toEqual([{ label: "Chat", value: { text: "Supergroup" } }])
  })
})

describe("CHAT_FACT_TRANSLATIONS", () => {
  test("has a Japanese word for the label and every kind", () => {
    expect(Object.keys(CHAT_FACT_TRANSLATIONS.ja!).sort()).toEqual(["Chat", ...Object.values(CHAT_KIND_WORDS)].sort())
  })
})
