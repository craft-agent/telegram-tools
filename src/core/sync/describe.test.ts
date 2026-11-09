import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { callDescription } from "../describe"
import { CHANNEL, SUPERGROUP } from "../telegram/mirror.testing"
import { DOWNLOAD_CONTEXT } from "../tool.testing"
import { telegramSyncAdd } from "./add"
import { telegramSyncRemove } from "./remove"
import { createSyncFixture, SUPERGROUP_B, type SyncFixture } from "./sync.testing"

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

const describeCall = (tool: typeof telegramSyncAdd | typeof telegramSyncRemove, args: object) =>
  callDescription(tool, args, { cwd: t.stateDir, stateDir: t.stateDir, ...DOWNLOAD_CONTEXT })

const MIRRORED = { label: "Mirrored messages", value: { text: "Deleted" } }

describe("sync add: the approval description", () => {
  test("states the intent", () => {
    expect(telegramSyncAdd.intent).toBe("About to add chats to the sync list")
  })

  test("names one chat in the headline and shows its kind, with no text", async () => {
    expect(await describeCall(telegramSyncAdd, { chats: [SUPERGROUP] })).toEqual({
      headline: { text: "About to add {chat} to the sync list", values: { chat: "Old Friends" } },
      facts: [{ label: "Chat", value: { text: "Supergroup" } }],
    })
  })

  test("counts several chats in a fact, with no headline, and lists them in the order given", async () => {
    expect(await describeCall(telegramSyncAdd, { chats: [CHANNEL, SUPERGROUP] })).toEqual({
      facts: [{ label: "Chats", value: "2" }],
      text: { label: "Chat list", body: `News (${CHANNEL})\nOld Friends (${SUPERGROUP})` },
    })
  })

  test("gives no headline for one chat without a name, and lists its id", async () => {
    expect(await describeCall(telegramSyncAdd, { chats: [SUPERGROUP_B] })).toEqual({
      facts: [{ label: "Chat", value: { text: "Supergroup" } }],
      text: { label: "Chat list", body: SUPERGROUP_B },
    })
  })

  test("lists a chat without a name by its id among others", async () => {
    const description = await describeCall(telegramSyncAdd, { chats: [SUPERGROUP_B, SUPERGROUP] })
    expect(description?.text?.body).toBe(`${SUPERGROUP_B}\nOld Friends (${SUPERGROUP})`)
  })

  test("gives no description for a missing chat, a name or a chat named twice", async () => {
    expect(await describeCall(telegramSyncAdd, { chats: ["-1001000000099"] })).toBeUndefined()
    expect(await describeCall(telegramSyncAdd, { chats: [SUPERGROUP, "-1001000000099"] })).toBeUndefined()
    expect(await describeCall(telegramSyncAdd, { chats: ["Old Friends"] })).toBeUndefined()
    expect(await describeCall(telegramSyncAdd, { chats: [SUPERGROUP, SUPERGROUP] })).toBeUndefined()
  })

  test("gives the same description for the same state", async () => {
    const args = { chats: [SUPERGROUP, CHANNEL] }
    expect(await describeCall(telegramSyncAdd, args)).toEqual(await describeCall(telegramSyncAdd, args))
  })
})

describe("sync remove: the approval description", () => {
  test("states the intent", () => {
    expect(telegramSyncRemove.intent).toBe("About to remove chats from the sync list")
  })

  test("shows that the mirrored messages go first, then the kind of chat", async () => {
    expect(await describeCall(telegramSyncRemove, { chats: [SUPERGROUP] })).toEqual({
      headline: { text: "About to remove {chat} from the sync list", values: { chat: "Old Friends" } },
      facts: [MIRRORED, { label: "Chat", value: { text: "Supergroup" } }],
    })
  })

  test("shows the deletion and the count, with no headline, and lists the chats in the order given", async () => {
    expect(await describeCall(telegramSyncRemove, { chats: [CHANNEL, SUPERGROUP] })).toEqual({
      facts: [MIRRORED, { label: "Chats", value: "2" }],
      text: { label: "Chat list", body: `News (${CHANNEL})\nOld Friends (${SUPERGROUP})` },
    })
  })

  test("gives no headline for one chat without a name, and lists its id", async () => {
    expect(await describeCall(telegramSyncRemove, { chats: [SUPERGROUP_B] })).toEqual({
      facts: [MIRRORED, { label: "Chat", value: { text: "Supergroup" } }],
      text: { label: "Chat list", body: SUPERGROUP_B },
    })
  })

  test("gives no description for a missing chat, a name or a chat named twice", async () => {
    expect(await describeCall(telegramSyncRemove, { chats: ["-1001000000099"] })).toBeUndefined()
    expect(await describeCall(telegramSyncRemove, { chats: ["Old Friends"] })).toBeUndefined()
    expect(await describeCall(telegramSyncRemove, { chats: [CHANNEL, CHANNEL] })).toBeUndefined()
  })

  test("gives the same description for the same state", async () => {
    const args = { chats: [SUPERGROUP, CHANNEL] }
    expect(await describeCall(telegramSyncRemove, args)).toEqual(await describeCall(telegramSyncRemove, args))
  })
})
