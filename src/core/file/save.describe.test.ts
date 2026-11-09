import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { callDescription } from "../describe"
import type { MediaInfo } from "../telegram/mirror-input"
import { NOW, OTHER_USER, USER } from "../telegram/mirror.testing"
import { DOWNLOAD_CONTEXT } from "../tool.testing"
import { telegramFileSave } from "./save"
import { createSaveFixture, MESSAGE_ID, saveArgs, type SaveFixture } from "./save.testing"

let t: SaveFixture

beforeEach(() => {
  t = createSaveFixture()
  t.chat.follow({ name: "Alice Example" })
})

afterEach(async () => {
  await t.close()
})

const describeCall = (args: object) =>
  callDescription(telegramFileSave, args, { cwd: t.stateDir, stateDir: t.stateDir, ...DOWNLOAD_CONTEXT })

const DOCUMENT: MediaInfo = { type: "document", name: "notes.txt", size: 1234 }

const storeMedia = (media: MediaInfo, extra: { edited?: number } = {}) =>
  t.chat.store({ id: MESSAGE_ID, media, ...extra })

describe("save: the approval description", () => {
  test("states the intent", () => {
    expect(telegramFileSave.intent).toBe("About to save a message's file")
  })

  test("names the file and the chat, and shows the kind of chat, the kind of file and the size", async () => {
    storeMedia(DOCUMENT)
    expect(await describeCall(saveArgs())).toEqual({
      headline: {
        text: "About to save {file} from {chat}",
        values: { file: "notes.txt", chat: "Alice Example" },
      },
      facts: [
        { label: "Chat", value: { text: "Person" } },
        { label: "File", value: { text: "Document" } },
        { label: "Size", value: { text: "{bytes} bytes", values: { bytes: 1234 } } },
      ],
      pins: { edited: "0" },
    })
  })

  test("adds Unpack before Size when the call asks to unpack", async () => {
    storeMedia(DOCUMENT)
    const description = await describeCall(saveArgs({ unpack: true }))
    expect(description?.facts.map((fact) => fact.label)).toEqual(["Chat", "File", "Unpack", "Size"])
    expect(description?.facts[2]).toEqual({ label: "Unpack", value: { text: "Yes" } })
  })

  test("names the chat only for a file without a name, and shows its kind", async () => {
    storeMedia({ type: "photo" })
    const description = await describeCall(saveArgs())
    expect(description?.headline).toEqual({
      text: "About to save a file from {chat}",
      values: { chat: "Alice Example" },
    })
    expect(description?.facts).toEqual([
      { label: "Chat", value: { text: "Person" } },
      { label: "File", value: { text: "Photo" } },
    ])
  })

  test("shows a kind of media it has no word for as the mirror names it", async () => {
    storeMedia({ type: "animation" })
    expect((await describeCall(saveArgs()))?.facts[1]).toEqual({ label: "File", value: "animation" })
  })

  test("shows only the chat, with no pin, for a message the mirror lacks", async () => {
    const description = await describeCall(saveArgs())
    expect(description).toEqual({
      headline: { text: "About to save a file from {chat}", values: { chat: "Alice Example" } },
      facts: [{ label: "Chat", value: { text: "Person" } }],
    })
  })

  test("names the file only for a chat without a name", async () => {
    t.chat.follow({ id: OTHER_USER, name: null, username: null })
    t.chat.store({ chat: OTHER_USER, id: MESSAGE_ID, media: DOCUMENT })
    const description = await describeCall(saveArgs({ chat: OTHER_USER }))
    expect(description?.headline).toEqual({ text: "About to save {file}", values: { file: "notes.txt" } })
  })

  test("pins the edit time, and the pin changes with it", async () => {
    storeMedia(DOCUMENT, { edited: NOW + 1000 })
    const first = await describeCall(saveArgs())
    expect(first?.pins).toEqual({ edited: String(NOW + 1000) })
    storeMedia(DOCUMENT, { edited: NOW + 2000 })
    expect((await describeCall(saveArgs()))?.pins).toEqual({ edited: String(NOW + 2000) })
  })

  test("gives no description for a chat the mirror lacks or a name instead of an id", async () => {
    expect(await describeCall(saveArgs({ chat: OTHER_USER }))).toBeUndefined()
    expect(await describeCall(saveArgs({ chat: "Alice Example" }))).toBeUndefined()
    expect(await describeCall({ chat: USER, id: MESSAGE_ID, account: "missing" })).toBeUndefined()
  })

  test("gives the same description for the same state", async () => {
    storeMedia(DOCUMENT)
    expect(await describeCall(saveArgs({ unpack: true }))).toEqual(await describeCall(saveArgs({ unpack: true })))
  })
})
