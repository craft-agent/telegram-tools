import { describe, expect, test } from "bun:test"
import { ALL_TOOLS } from "../tools"
import { gateRefusal } from "../entry/gate"
import { existingChat, UNKNOWN_CHAT_MESSAGE } from "./chat/chat-rows"
import { telegramChatRead } from "./chat/read"
import { listedChat, UNKNOWN_LISTED_CHAT_MESSAGE } from "./telegram/sync-request-calls"
import { syncAdd, syncRemove, UNKNOWN_SYNC_CHAT_MESSAGE } from "./telegram/sync-list-requests"
import { createTestMirror } from "./telegram/mirror.testing"
import { ToolError } from "./errors"
import { invoke, type ToolContext } from "./tool"

const EXCLUDED = "-1001234567890"
const OTHER = "123456789"
const ctx: ToolContext = {
  cwd: "/unavailable",
  downloadDir: "/unavailable",
  downloadMaxMb: 100,
  options: { exclude_chats: [EXCLUDED] },
  get stateDir(): string {
    throw new Error("The gate must not open the mirror or contact the service")
  },
}

const ARGUMENTS: Record<string, Record<string, unknown>> = {
  telegram_chat_read: { method: "view" },
  telegram_file_save: { id: 1 },
  telegram_file_send: { files: [{ path: "note.txt" }] },
  telegram_message_send: { text: "hello" },
  telegram_message_edit: { id: 1, text: "changed" },
  telegram_message_delete: { id: 1 },
  telegram_message_react: { id: 1, emoji: "👍" },
  telegram_message_pin: { id: 1 },
  telegram_chat_mark_read: { up_to: 1 },
  telegram_sync_add: {},
  telegram_sync_remove: {},
}

describe("chat exclusion gates", () => {
  test("the refusal messages match the actual unknown-chat paths", async () => {
    const t = createTestMirror()
    try {
      expect(() => existingChat(t.mirror, EXCLUDED)).toThrow(new ToolError("not_found", UNKNOWN_CHAT_MESSAGE))
      expect(() => listedChat(t.mirror, EXCLUDED)).toThrow(new ToolError("not_found", UNKNOWN_LISTED_CHAT_MESSAGE))
      const service = {
        mirror: t.mirror,
        settings: { channels: false, now: Date.now },
        failRun() {
          throw new Error("No write should run")
        },
        forgetChats() {
          throw new Error("No write should run")
        },
      }
      for (const change of [syncAdd, syncRemove]) {
        await expect(change(service, { chats: [EXCLUDED] })).rejects.toMatchObject({
          code: "not_found",
          message: UNKNOWN_SYNC_CHAT_MESSAGE(EXCLUDED),
        })
      }
    } finally {
      t.close()
    }
  })

  for (const spec of ALL_TOOLS) {
    const multiple = "chats" in spec.input.shape
    if (!("chat" in spec.input.shape) && !multiple) continue
    const args = { ...ARGUMENTS[spec.id], ...(multiple ? { chats: [OTHER, EXCLUDED] } : { chat: EXCLUDED }) }
    const message = multiple
      ? UNKNOWN_SYNC_CHAT_MESSAGE(EXCLUDED)
      : ["telegram_message_send", "telegram_file_send"].includes(spec.id)
        ? UNKNOWN_LISTED_CHAT_MESSAGE
        : UNKNOWN_CHAT_MESSAGE

    test(`${spec.id} refuses before approval and execution with its unknown-chat error`, async () => {
      expect(spec.input.strict().safeParse(args).success).toBe(true)
      expect(await gateRefusal(spec, args, ctx)).toMatchObject({ code: "not_found", message })
      await expect(invoke(spec, args, ctx)).rejects.toMatchObject({ code: "not_found", message })
    })

    test(`${spec.id} permits a chat not excluded`, async () => {
      const allowed = { ...args, ...(multiple ? { chats: [OTHER] } : { chat: OTHER }) }
      expect(await gateRefusal(spec, allowed, ctx)).toBeUndefined()
    })

    test(`${spec.id} fails closed on a malformed setting without echoing it`, async () => {
      const malformed: ToolContext = Object.assign(Object.create(ctx), {
        options: { exclude_chats: ["private-secret"] },
      })
      const refusal = await gateRefusal(spec, args, malformed)
      expect(refusal?.code).toBe("invalid_argument")
      expect(refusal?.message).toContain("exclude_chats")
      expect(refusal?.message).not.toContain("private-secret")
    })
  }

  test.each(["view", "topics", "around", "fetch", "search"])(
    "chat read %s refuses an excluded chat",
    async (method) => {
      const args = {
        method,
        chat: EXCLUDED,
        ...(method === "around" ? { id: 1 } : {}),
        ...(method === "search" ? { query: "hello" } : {}),
      }
      expect(await gateRefusal(telegramChatRead, args, ctx)).toMatchObject({
        code: "not_found",
        message: UNKNOWN_CHAT_MESSAGE,
      })
    },
  )

  test("list and search without a chat pass", async () => {
    expect(await gateRefusal(telegramChatRead, { method: "list" }, ctx)).toBeUndefined()
    expect(await gateRefusal(telegramChatRead, { method: "search", query: "hello" }, ctx)).toBeUndefined()
  })
})
