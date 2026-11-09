import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { callDescription } from "../describe"
import { upsertTopics } from "../telegram/ingest-chats"
import { SUPERGROUP } from "../telegram/mirror.testing"
import { DOWNLOAD_CONTEXT } from "../tool.testing"
import { translator } from "../words"
import { telegramMessageSend } from "./send"
import { createSendFixture, type SendFixture } from "./send.testing"
import { MESSAGE_TRANSLATIONS } from "./words"

const ja = translator(MESSAGE_TRANSLATIONS, "ja")

let t: SendFixture

beforeEach(() => {
  t = createSendFixture()
})

afterEach(async () => {
  await t.stopServices()
  t.close()
})

/** The description of a send that exercises every branch: the headline, a topic, a reply and the text. */
async function fullDescription() {
  t.known({ id: SUPERGROUP, kind: "supergroup", name: "Old Friends", username: null })
  upsertTopics(t.mirror, [{ chat: SUPERGROUP, id: 5, title: "Talk" }], 1)
  const ctx = { cwd: t.stateDir, stateDir: t.stateDir, ...DOWNLOAD_CONTEXT }
  const args = { chat: SUPERGROUP, text: "hi", topic: 5, reply_to: 42 }
  return (await callDescription(telegramMessageSend, args, ctx))!
}

describe("MESSAGE_TRANSLATIONS", () => {
  test("has a Japanese word for every word the send tool writes", async () => {
    const description = await fullDescription()
    const [, topic, reply] = description.facts
    const words = [
      telegramMessageSend.title,
      telegramMessageSend.intent!,
      description.headline!.text,
      topic!.label,
      reply!.label,
      (reply!.value as { text: string }).text,
      description.text!.label,
    ]
    expect(Object.keys(MESSAGE_TRANSLATIONS.ja!).sort()).toEqual(words.sort())
  })

  test("keeps the placeholders of the templates, so the translator gives the Japanese", async () => {
    const description = await fullDescription()
    const headline = description.headline!.text
    const value = (description.facts[2]!.value as { text: string }).text
    expect(ja.template(headline)).toBe(MESSAGE_TRANSLATIONS.ja![headline]!)
    expect(ja.template(headline)).toContain("{chat}")
    expect(ja.template(value)).toBe(MESSAGE_TRANSLATIONS.ja![value]!)
    expect(ja.template(value)).toContain("{id}")
  })
})
