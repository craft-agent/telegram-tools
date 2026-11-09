import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { callDescription } from "../describe"
import { CHANNEL, SUPERGROUP } from "../telegram/mirror.testing"
import { DOWNLOAD_CONTEXT } from "../tool.testing"
import { translator } from "../words"
import { telegramSyncAdd } from "./add"
import { telegramSyncRemove } from "./remove"
import { createSyncFixture, SUPERGROUP_B, type SyncFixture } from "./sync.testing"
import { SYNC_TRANSLATIONS } from "./words"

const ja = translator(SYNC_TRANSLATIONS, "ja")

let t: SyncFixture

beforeEach(() => {
  t = createSyncFixture()
  t.known({ id: SUPERGROUP, kind: "supergroup", name: "Old Friends", username: null })
  t.known({ id: CHANNEL, kind: "channel", name: "News", username: "news_example" })
  t.known({ id: SUPERGROUP_B, kind: "supergroup", name: null, username: null })
})

afterEach(async () => {
  await t.stopServices()
  t.close()
})

const describeCall = async (tool: typeof telegramSyncAdd | typeof telegramSyncRemove, chats: string[]) =>
  (await callDescription(tool, { chats }, { cwd: t.stateDir, stateDir: t.stateDir, ...DOWNLOAD_CONTEXT }))!

/** Every description the tools write: one named chat, several chats and a chat without a name. */
async function descriptions() {
  const add = {
    one: await describeCall(telegramSyncAdd, [SUPERGROUP]),
    many: await describeCall(telegramSyncAdd, [SUPERGROUP, CHANNEL]),
    unnamed: await describeCall(telegramSyncAdd, [SUPERGROUP_B]),
  }
  const remove = {
    one: await describeCall(telegramSyncRemove, [SUPERGROUP]),
  }
  return { add, remove }
}

describe("SYNC_TRANSLATIONS", () => {
  test("has a Japanese word for every word the sync tools write", async () => {
    const { add, remove } = await descriptions()
    const [mirrored] = remove.one.facts
    const words = [
      telegramSyncAdd.title,
      telegramSyncAdd.intent!,
      add.one.headline!.text,
      add.many.facts[0]!.label,
      add.many.text!.label,
      telegramSyncRemove.title,
      telegramSyncRemove.intent!,
      remove.one.headline!.text,
      mirrored!.label,
      (mirrored!.value as { text: string }).text,
    ]
    expect(Object.keys(SYNC_TRANSLATIONS.ja!).sort()).toEqual(words.sort())
    expect(add.unnamed.text!.label).toBe(add.many.text!.label)
    expect(add.many.headline).toBeUndefined()
  })

  test("keeps the placeholders of the templates, so the translator gives the Japanese", async () => {
    const { add, remove } = await descriptions()
    for (const description of [add.one, remove.one]) {
      const headline = description.headline!.text
      expect(ja.template(headline)).toBe(SYNC_TRANSLATIONS.ja![headline]!)
      expect(ja.template(headline)).toContain("{chat}")
    }
  })
})
