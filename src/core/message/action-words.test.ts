import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { callDescription } from "../describe"
import { OTHER_USER, USER } from "../telegram/mirror.testing"
import { DOWNLOAD_CONTEXT } from "../tool.testing"
import { translator } from "../words"
import { ACTION_TRANSLATIONS } from "./action-words"
import { createActionFixture, OWN_ID, type ActionFixture } from "./action.testing"
import { telegramMessageDelete } from "./delete"
import { telegramMessageEdit } from "./edit"

const ja = translator(ACTION_TRANSLATIONS, "ja")

let t: ActionFixture

beforeEach(() => {
  t = createActionFixture()
})

afterEach(async () => {
  await t.stopServices()
  t.close()
})

/** The descriptions of both tools for a named chat and for Saved Messages, each with a current text. */
async function descriptions() {
  const ctx = { cwd: t.stateDir, stateDir: t.stateDir, ...DOWNLOAD_CONTEXT }
  t.own()
  t.follow({ id: OTHER_USER, kind: "self", name: "Me", username: null })
  t.store({ chat: OTHER_USER, id: OWN_ID, fromMe: true, sender: null, body: "old text" })
  const edit = (chat: string) => callDescription(telegramMessageEdit, { chat, id: OWN_ID, text: "new text" }, ctx)
  const remove = (chat: string) => callDescription(telegramMessageDelete, { chat, id: OWN_ID }, ctx)
  return (await Promise.all([edit(USER), edit(OTHER_USER), remove(USER), remove(OTHER_USER)])).map((one) => one!)
}

describe("ACTION_TRANSLATIONS", () => {
  test("has a Japanese word for every word the edit and delete tools write", async () => {
    const [editNamed, editSaved, deleteNamed, deleteSaved] = await descriptions()
    const words = [
      telegramMessageEdit.title,
      telegramMessageEdit.intent!,
      telegramMessageDelete.title,
      telegramMessageDelete.intent!,
      editNamed!.headline!.text,
      editSaved!.headline!.text,
      deleteNamed!.headline!.text,
      deleteSaved!.headline!.text,
      editNamed!.facts[1]!.label,
      editNamed!.facts[2]!.label,
      editNamed!.text!.label,
    ]
    expect(Object.keys(ACTION_TRANSLATIONS.ja!).sort()).toEqual(words.sort())
  })

  test("keeps the placeholders of the headline templates, so the translator gives the Japanese", async () => {
    const [editNamed, editSaved, deleteNamed, deleteSaved] = await descriptions()
    for (const { headline } of [editNamed!, editSaved!, deleteNamed!, deleteSaved!]) {
      const { text } = headline!
      expect(ja.template(text)).toBe(ACTION_TRANSLATIONS.ja![text]!)
      expect(ja.template(text)).toContain("{id}")
    }
    expect(ja.template(editNamed!.headline!.text)).toContain("{chat}")
    expect(ja.template(deleteNamed!.headline!.text)).toContain("{chat}")
  })
})
