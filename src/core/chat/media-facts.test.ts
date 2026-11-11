import { describe, expect, test } from "bun:test"
import { MEDIA_FACT_TRANSLATIONS, MEDIA_KIND_WORDS, mediaKindValue } from "./media-facts"

describe("mediaKindValue", () => {
  test.each(Object.entries(MEDIA_KIND_WORDS))("gives %s as a value template", (kind, word) => {
    expect(mediaKindValue(kind)).toEqual({ text: word })
  })

  test.each(["animation", "constructor", "toString", "__proto__"])("keeps unknown kind %s as data", (kind) => {
    expect(mediaKindValue(kind)).toBe(kind)
  })
})

describe("MEDIA_FACT_TRANSLATIONS", () => {
  test("has a Japanese word for the label and every kind", () => {
    expect(Object.keys(MEDIA_FACT_TRANSLATIONS.ja!).sort()).toEqual(
      ["Media", ...Object.values(MEDIA_KIND_WORDS)].sort(),
    )
  })
})
