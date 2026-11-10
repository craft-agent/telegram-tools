import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { callDescription } from "../../describe"
import { OTHER_USER, USER } from "../../telegram/mirror.testing"
import { translator } from "../../words"
import { createFileSendFixture, type FileSendFixture } from "./tool.testing"
import { telegramFileSend } from "./tool"
import { FILE_SEND_TRANSLATIONS } from "./words"

const ja = translator(FILE_SEND_TRANSLATIONS, "ja")

let t: FileSendFixture

beforeEach(() => {
  t = createFileSendFixture()
  t.known({ id: USER, kind: "user", name: "Alice Example" })
  t.known({ id: OTHER_USER, kind: "self", name: "Alice Example" })
  t.write("a.txt", "x")
  t.write("b.txt", "y")
})

afterEach(async () => {
  await t.close()
})

const describeCall = async (args: object) =>
  (await callDescription(telegramFileSend, { chat: USER, caption: "hi", ...args }, t.context()))!

/** Every description the tool writes: both headlines of a named chat and of Saved Messages, the count and the caption. */
async function descriptions() {
  const one = await describeCall({ files: [{ path: "a.txt" }] })
  const many = await describeCall({ files: [{ path: "a.txt" }, { path: "b.txt" }] })
  const oneSaved = await describeCall({ chat: OTHER_USER, files: [{ path: "a.txt" }] })
  const manySaved = await describeCall({ chat: OTHER_USER, files: [{ path: "a.txt" }, { path: "b.txt" }] })
  return { one, many, oneSaved, manySaved }
}

describe("FILE_SEND_TRANSLATIONS", () => {
  test("has a Japanese word for every word the send tool writes", async () => {
    const { one, many, oneSaved, manySaved } = await descriptions()
    const files = many.facts.find((fact) => fact.label === "Files")!
    const words = [
      telegramFileSend.title,
      telegramFileSend.intent!,
      one.headline!.text,
      many.headline!.text,
      oneSaved.headline!.text,
      manySaved.headline!.text,
      files.label,
      (files.value as { text: string }).text,
      one.text!.label,
    ]
    expect(Object.keys(FILE_SEND_TRANSLATIONS.ja!).sort()).toEqual(words.sort())
  })

  test("keeps the placeholders of the templates, so the translator gives the Japanese", async () => {
    const { one, many, oneSaved, manySaved } = await descriptions()
    const files = many.facts.find((fact) => fact.label === "Files")!
    for (const [text, placeholders] of [
      [one.headline!.text, ["{file}", "{chat}"]],
      [many.headline!.text, ["{chat}"]],
      [oneSaved.headline!.text, ["{file}"]],
      [manySaved.headline!.text, []],
      [(files.value as { text: string }).text, ["{count}"]],
    ] as const) {
      expect(ja.template(text)).toBe(FILE_SEND_TRANSLATIONS.ja![text]!)
      for (const placeholder of placeholders) expect(ja.template(text)).toContain(placeholder)
    }
  })
})
