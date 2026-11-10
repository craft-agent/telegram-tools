import { Long, tl } from "@mtcute/core"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rpcError } from "./login.testing"
import { rowsOf } from "./mirror.testing"
import { failureOf } from "./service.testing"
import { answered } from "./sync-client-send.testing"
import { KEPT } from "./sync-requests.testing"
import {
  FILE_A,
  FILE_B,
  answerFiles,
  outboxFile,
  requestsOf,
  sendFiles,
  type FileAnswerSetup,
} from "./sync-send-files.testing"
import { seedSendChats } from "./sync-send.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture
let outcome: Awaited<ReturnType<SyncFixture["running"]>>["outcome"]

const CAPTION = "a made-up caption"

beforeEach(async () => {
  fixture = syncFixture()
  seedSendChats(fixture)
  outcome = (await fixture.running()).outcome
})

afterEach(() => fixture.close())

const files = (count: number) => [FILE_A, FILE_B].slice(0, count).map((file) => outboxFile(fixture, file))
const failure = (count = 1, setup: Omit<FileAnswerSetup, "firstId"> = {}) => {
  answerFiles(fixture, { firstId: 50, ...setup })
  return failureOf(sendFiles(fixture, { chat: KEPT, files: files(count), caption: CAPTION }))
}
const sentCalls = () =>
  requestsOf(fixture, "messages.sendMedia").length + requestsOf(fixture, "messages.sendMultiMedia").length
const storedCount = () =>
  fixture.mirror((mirror) => rowsOf(mirror, "SELECT COUNT(*) AS n FROM messages WHERE chat = ?", KEPT)[0]?.n)

/** An answer that comes after the connection dropped and came back, as a reconnect during the call shows. */
const afterReconnect = (error: Error) => () => {
  fixture.client.drop()
  fixture.client.regain()
  return error
}

const REFUSALS: [string, tl.RpcError, string][] = [
  ["a flood wait", answered(420, "FLOOD_WAIT_30"), "rate_limited"],
  ["a slow-mode wait", answered(420, "SLOWMODE_WAIT_17"), "rate_limited"],
  ["a chat that does not take writes", answered(403, "CHAT_WRITE_FORBIDDEN"), "forbidden"],
  ["a chat that takes no media", answered(403, "CHAT_SEND_MEDIA_FORBIDDEN"), "forbidden"],
  ["a chat that takes no documents", answered(403, "CHAT_SEND_DOCS_FORBIDDEN"), "forbidden"],
  ["a chat that is gone", answered(400, "PEER_ID_INVALID"), "not_found"],
  ["a reply to a message that is gone", answered(400, "REPLY_MESSAGE_ID_INVALID"), "not_found"],
  ["a caption that is too long", answered(400, "MEDIA_CAPTION_TOO_LONG"), "invalid_argument"],
  ["a refusal of another name", answered(400, "SOMETHING_NEW"), "upstream_error"],
]

describe("a file send Telegram refuses", () => {
  for (const [name, error, code] of REFUSALS) {
    for (const count of [1, 2]) {
      test(`${name} is ${code} for ${count} file(s), with nothing sent and the call not repeated`, async () => {
        const refused = await failure(count, { failSend: () => error })

        expect(refused).toMatchObject({ code })
        expect(refused.message).toMatch(/nothing was sent\.( Try again in \d+ seconds\.)?$/)
        expect(sentCalls()).toBe(1)
        expect(fixture.pauses).toEqual([])
        expect(storedCount()).toBe(3)
      })
    }
  }

  test("a caption refusal does not talk of a text", async () => {
    const refused = await failure(1, { failSend: () => answered(400, "MEDIA_CAPTION_TOO_LONG") })

    expect(refused.message).toBe("Telegram refused the caption (MEDIA_CAPTION_TOO_LONG); nothing was sent.")
  })
})

describe("a file send whose connection came back during the call", () => {
  for (const [name, error] of REFUSALS) {
    test(`is uncertain even for ${name}`, async () => {
      const refused = await failure(2, { failSend: afterReconnect(error) })

      expect(refused).toMatchObject({ code: "uncertain" })
      expect(refused.message).toEndWith("Check the chat in Telegram before trying again.")
      expect(sentCalls()).toBe(1)
    })
  }
})

describe("a file send that may have gone out", () => {
  const others: [string, Error][] = [
    ["mtcute's own timeout", answered(400, "TIMEOUT")],
    ["a server error", answered(500, "INTERNAL")],
    ["an error that is not Telegram's", new Error("socket to +15550100123 broke")],
  ]
  for (const [name, error] of others) {
    test(`${name} is uncertain, and the call is not repeated`, async () => {
      const refused = await failure(2, { failSend: () => error })

      expect(refused).toMatchObject({ code: "uncertain" })
      expect(refused.message).not.toContain("15550100123")
      expect(sentCalls()).toBe(1)
      expect(storedCount()).toBe(3)
    })
  }

  test("a session that ended is uncertain and ends the service", async () => {
    expect(await failure(1, { failSend: () => answered(401, "SESSION_REVOKED") })).toMatchObject({ code: "uncertain" })
    expect(await outcome).toMatchObject({ status: "logged out" })
  })

  test("a response that does not name every file's message is uncertain, and stores nothing", async () => {
    const missing = await failure(2, {
      alter: (updates) => ({
        ...updates,
        updates: updates.updates.filter((update) => update._ !== "updateMessageID" || update.id !== 51),
      }),
    })

    expect(missing).toMatchObject({
      code: "uncertain",
      message: expect.stringContaining("Telegram's answer did not name every file's message"),
    })
    expect(storedCount()).toBe(3)
  })

  test("a response whose id update carries another random id is uncertain", async () => {
    const other = Long.fromString("42")

    const refused = await failure(2, {
      alter: (updates) => ({
        ...updates,
        updates: updates.updates.map((update) =>
          update._ === "updateMessageID" ? { ...update, randomId: other } : update,
        ),
      }),
    })

    expect(refused).toMatchObject({ code: "uncertain" })
  })

  test("a response of another kind, or the short form, is uncertain", async () => {
    for (const response of [
      { _: "updatesTooLong" },
      { _: "updateShortSentMessage", out: true, id: 9, pts: 1, ptsCount: 1, date: 1 },
    ] as const) {
      expect(await failure(1, { alter: () => response })).toMatchObject({ code: "uncertain" })
    }
    expect(storedCount()).toBe(3)
  })

  test("never puts a name, a caption, the chat or a random id in the log", async () => {
    await failure(2, { failSend: () => rpcError(400, "TIMEOUT") })
    const [{ request }] = requestsOf(fixture, "messages.sendMultiMedia")

    const log = fixture.logs.join("\n")
    expect(log).toContain("send failed: TIMEOUT")
    for (const secret of [FILE_A.name, FILE_B.name, CAPTION, KEPT, request.multiMedia[0]!.randomId.toString()]) {
      expect(log).not.toContain(secret)
    }
  })
})
