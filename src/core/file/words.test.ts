import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { callDescription } from "../describe"
import type { MediaInfo } from "../telegram/mirror-input"
import { OTHER_USER, USER } from "../telegram/mirror.testing"
import { DOWNLOAD_CONTEXT } from "../tool.testing"
import { translator } from "../words"
import { telegramFileSave } from "./save"
import { createSaveFixture, MESSAGE_ID, saveArgs, type SaveFixture } from "./save.testing"
import { FILE_TRANSLATIONS } from "./words"

const ja = translator(FILE_TRANSLATIONS, "ja")

let t: SaveFixture

beforeEach(() => {
  t = createSaveFixture()
  t.chat.follow({ name: "Alice Example" })
})

afterEach(async () => {
  await t.close()
})

async function describeMessage(id: number, media: MediaInfo, args: object = {}, chat = USER) {
  t.chat.store({ chat, id, media })
  const ctx = { cwd: t.stateDir, stateDir: t.stateDir, ...DOWNLOAD_CONTEXT }
  return (await callDescription(telegramFileSave, saveArgs({ id, chat, ...args }), ctx))!
}

/** The save descriptions with all three headlines and the unpack fact. */
async function descriptions() {
  const named = await describeMessage(MESSAGE_ID, { type: "document", name: "notes.txt" }, { unpack: true })
  const unnamed = await describeMessage(MESSAGE_ID + 1, { type: "photo" })
  t.chat.follow({ id: OTHER_USER, name: null, username: null })
  const fileOnly = await describeMessage(MESSAGE_ID + 2, { type: "document", name: "notes.txt" }, {}, OTHER_USER)
  return { named, unnamed, fileOnly }
}

describe("FILE_TRANSLATIONS", () => {
  test("has a Japanese word for every save-specific word the tool writes", async () => {
    const { named, unnamed, fileOnly } = await descriptions()
    const [, file, unpack] = named.facts
    const words = [
      telegramFileSave.title,
      telegramFileSave.intent!,
      named.headline!.text,
      unnamed.headline!.text,
      fileOnly.headline!.text,
      file!.label,
      unpack!.label,
      (unpack!.value as { text: string }).text,
    ]
    expect(Object.keys(FILE_TRANSLATIONS.ja!).sort()).toEqual(words.sort())
  })

  test("keeps the placeholders of the templates, so the translator gives the Japanese", async () => {
    const { named, unnamed, fileOnly } = await descriptions()
    for (const [description, placeholders] of [
      [named, ["{file}", "{chat}"]],
      [unnamed, ["{chat}"]],
      [fileOnly, ["{file}"]],
    ] as const) {
      const headline = description.headline!.text
      expect(ja.template(headline)).toBe(FILE_TRANSLATIONS.ja![headline]!)
      for (const placeholder of placeholders) expect(ja.template(headline)).toContain(placeholder)
    }
  })
})
