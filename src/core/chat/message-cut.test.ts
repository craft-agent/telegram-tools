import { describe, expect, test } from "bun:test"
import { cutMessage, dropMetadata, messageTextLength } from "./message-cut"
import type { MessageEntry } from "./message-schema"

const TIME = "2026-11-07T14:03:12.345+09:00"

const full: MessageEntry = {
  id: 1,
  time: TIME,
  from: "Alice",
  text: "1234",
  links: [{ text: "ab", url: "https://example.com" }],
  media: { type: "photo" },
  reply_to: { id: 9, quote: "qq", text: "rrr" },
  earlier_versions: [
    { time: TIME, text: "vvvvv" },
    { time: TIME, media: { type: "photo" } },
  ],
  reactions: [{ emoji: "👍", count: 1 }],
}

describe("cutMessage", () => {
  test("counts the text, the quote, the text replied to and the earlier versions", () => {
    expect(messageTextLength(full)).toBe(4 + 2 + 3 + 5)
  })

  test("keeps the text first, then the quote, the text replied to and the earlier versions", () => {
    const cut = cutMessage(full, 7)
    expect(cut.text).toBe("1234")
    expect(cut.reply_to).toEqual({ id: 9, quote: "qq", text: "r" })
    expect(cut.earlier_versions?.[0]?.text).toBe("")
    expect(cut.earlier_versions?.[1]).toEqual({ time: TIME, media: { type: "photo" } })
    expect(cut.text_cut).toBe(true)
    expect(cutMessage(full, 3).text).toBe("123")
  })

  test("marks nothing when nothing is lost, and cuts no pair of surrogates in two", () => {
    expect(cutMessage(full, 100)).toEqual(full)
    expect(cutMessage({ ...full, text: "a😀b" }, 2).text).toBe("a")
  })
})

describe("dropMetadata", () => {
  test("drops earlier versions, then reactions, then links, then media", () => {
    const names = ["earlier_versions", "reactions", "links", "media"] as const
    let entry: MessageEntry | null = full
    const omitted: string[] = []
    for (const name of names) {
      entry = dropMetadata(entry!)
      omitted.push(name)
      expect(entry).not.toHaveProperty(name)
      expect(entry).toMatchObject({ text_cut: true, omitted, text: "1234" })
    }
    expect(entry).toHaveProperty("reply_to")
    expect(dropMetadata(entry!)).toBeNull()
  })

  test("skips what a message does not have, and leaves the original alone", () => {
    const plain: MessageEntry = { id: 1, time: TIME, from: "me", text: "x", media: { type: "photo" } }
    expect(dropMetadata(plain)).toMatchObject({ omitted: ["media"], text_cut: true })
    expect(plain.media).toEqual({ type: "photo" })
    expect(dropMetadata({ id: 1, time: TIME, from: "me", text: "x" })).toBeNull()
  })
})
