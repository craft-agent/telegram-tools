import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { callDescription } from "../describe"
import { OTHER_USER, USER } from "../telegram/mirror.testing"
import { DOWNLOAD_CONTEXT } from "../tool.testing"
import { translator } from "../words"
import { ACTION_TRANSLATIONS } from "./action-words"
import { createActionFixture, OWN_ID, THUMBS_UP, type ActionFixture } from "./action.testing"
import { telegramMessageDelete } from "./delete"
import { telegramMessageEdit } from "./edit"
import { telegramMessagePin } from "./pin"
import { telegramMessageReact } from "./react"

const ja = translator(ACTION_TRANSLATIONS, "ja")
const HEART = "❤️"

type Description = NonNullable<Awaited<ReturnType<typeof callDescription>>>

let t: ActionFixture

beforeEach(() => {
  t = createActionFixture()
})

afterEach(async () => {
  await t.stopServices()
  t.close()
})

/** The descriptions of each call of the action tools for a named chat and, second, for Saved Messages, each message with a text and the user's own reaction. */
async function descriptions() {
  const ctx = { cwd: t.stateDir, stateDir: t.stateDir, ...DOWNLOAD_CONTEXT }
  const reactions = [{ emoji: HEART, count: 1, mine: true as const }]
  t.own({ reactions })
  t.follow({ id: OTHER_USER, kind: "self", name: "Me", username: null })
  t.store({ chat: OTHER_USER, id: OWN_ID, fromMe: true, sender: null, body: "old text", reactions })
  const both = async (describeIn: (chat: string) => Promise<Description | undefined>): Promise<Description[]> =>
    (await Promise.all([describeIn(USER), describeIn(OTHER_USER)])).map((one) => one!)
  const id = OWN_ID
  return {
    edit: await both((chat) => callDescription(telegramMessageEdit, { chat, id, text: "new text" }, ctx)),
    remove: await both((chat) => callDescription(telegramMessageDelete, { chat, id }, ctx)),
    react: await both((chat) => callDescription(telegramMessageReact, { chat, id, emoji: THUMBS_UP }, ctx)),
    unreact: await both((chat) => callDescription(telegramMessageReact, { chat, id, remove: true }, ctx)),
    pin: await both((chat) =>
      callDescription(telegramMessagePin, { chat, id, notify: true, both_sides: chat === USER }, ctx),
    ),
    unpin: await both((chat) => callDescription(telegramMessagePin, { chat, id, unpin: true }, ctx)),
  }
}

describe("ACTION_TRANSLATIONS", () => {
  test("has a Japanese word for every word the action tools write", async () => {
    const all = await descriptions()
    const tools = [telegramMessageEdit, telegramMessageDelete, telegramMessageReact, telegramMessagePin]
    const words = [
      ...tools.flatMap(({ title, intent }) => [title, intent!]),
      ...Object.values(all).flatMap(([named, saved]) => [named!.headline!.text, saved!.headline!.text]),
      ...all.edit[0]!.facts.slice(1).map(({ label }) => label),
      all.edit[0]!.text!.label,
      all.react[0]!.facts[3]!.label,
      ...all.pin[0]!.facts.slice(3).map(({ label }) => label),
    ]
    expect(Object.keys(ACTION_TRANSLATIONS.ja!).sort()).toEqual(words.sort())
  })

  test("keeps the placeholders of the headline templates, so the translator gives the Japanese", async () => {
    const all = await descriptions()
    for (const [named, saved] of Object.values(all)) {
      for (const { headline } of [named!, saved!]) {
        const { text } = headline!
        expect(ja.template(text)).toBe(ACTION_TRANSLATIONS.ja![text]!)
        expect(ja.template(text)).toContain("{id}")
      }
    }
    for (const [named] of [all.edit, all.remove, all.react, all.unreact, all.unpin]) {
      expect(ja.template(named!.headline!.text)).toContain("{chat}")
    }
    for (const description of all.react) expect(ja.template(description.headline!.text)).toContain("{emoji}")
    for (const description of all.unreact) expect(ja.template(description.headline!.text)).not.toContain("{emoji}")
  })
})
