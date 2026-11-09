import { Long, tl } from "@mtcute/core"
import { describe, expect, test } from "bun:test"
import { ToolError, type ErrorCode } from "../errors"
import { FAKE_DATE, channelPeer, fakeMessage, fakeSelf, fakeSupergroup, fakeUser } from "./fake-telegram.testing"
import { rpcError } from "./login.testing"
import { UNCERTAIN_ADVICE } from "./service-errors"
import { answered } from "./sync-client-send.testing"
import { isRandomIdDuplicate, sendFailureOf, sentMessageOf } from "./sync-send-outcome"

const CALM = { reconnected: false, aborted: false }
const RECONNECTED = { reconnected: true, aborted: false }

const failureOf = (error: unknown, trouble = CALM) => sendFailureOf(error, trouble)

describe("a refusal Telegram gave", () => {
  const rateLimits: [string, number][] = [
    ["FLOOD_WAIT_30", 30],
    ["SLOWMODE_WAIT_17", 17],
    ["FLOOD_PREMIUM_WAIT_5", 5],
  ]
  for (const [text, seconds] of rateLimits) {
    test(`${text} is rate limited, with its seconds`, () => {
      expect(failureOf(answered(420, text))).toEqual(
        new ToolError(
          "rate_limited",
          `Telegram is limiting sends from this account; nothing was sent. Try again in ${seconds} seconds.`,
        ),
      )
    })
  }

  test("a wait written out without the seconds taken is still told by its number", () => {
    expect(failureOf(rpcError(420, "SLOWMODE_WAIT_9"))).toMatchObject({ code: "rate_limited" })
  })

  const families: [ErrorCode, number, string[]][] = [
    [
      "forbidden",
      403,
      [
        "CHAT_WRITE_FORBIDDEN",
        "CHAT_SEND_PLAIN_FORBIDDEN",
        "CHAT_RESTRICTED",
        "USER_BANNED_IN_CHANNEL",
        "CHAT_ADMIN_REQUIRED",
        "USER_IS_BLOCKED",
        "YOU_BLOCKED_USER",
        "PRIVACY_PREMIUM_REQUIRED",
        "TOPIC_CLOSED",
      ],
    ],
    [
      "not_found",
      400,
      [
        "PEER_ID_INVALID",
        "CHANNEL_PRIVATE",
        "CHANNEL_INVALID",
        "CHAT_ID_INVALID",
        "INPUT_USER_DEACTIVATED",
        "REPLY_MESSAGE_ID_INVALID",
        "MSG_ID_INVALID",
        "TOPIC_DELETED",
      ],
    ],
    ["invalid_argument", 400, ["MESSAGE_TOO_LONG", "MESSAGE_EMPTY"]],
  ]
  for (const [code, status, names] of families) {
    for (const name of names) {
      test(`${name} is ${code}, and nothing was sent`, () => {
        const failure = failureOf(answered(status, name))

        expect(failure.code).toBe(code)
        expect(failure.message).toContain(`(${name}); nothing was sent.`)
      })
    }
  }

  for (const status of [400, 403, 406]) {
    test(`another ${status} is an upstream error naming it`, () => {
      expect(failureOf(answered(status, "SOMETHING_NEW"))).toEqual(
        new ToolError("upstream_error", "Telegram refused the send (SOMETHING_NEW); nothing was sent."),
      )
    })
  }

  test("a refusal's own message text never reaches the answer", () => {
    const error = answered(403, "CHAT_WRITE_FORBIDDEN")
    error.message = "CHAT_WRITE_FORBIDDEN: a private note +15550100123"

    expect(failureOf(error).message).not.toContain("private")
  })
})

describe("a send that may have gone out", () => {
  const uncertain = (error: unknown, trouble = CALM) => {
    const failure = failureOf(error, trouble)
    expect(failure.code).toBe("uncertain")
    expect(failure.message).toMatch(/^The message may have been sent \(.+\)\. /)
    expect(failure.message.endsWith(UNCERTAIN_ADVICE)).toBe(true)
    return failure
  }

  test("mtcute's own timeout is not a refusal, although it comes as a 400", () => {
    uncertain(answered(400, "TIMEOUT"))
  })

  const others: [number, string][] = [
    [500, "INTERNAL"],
    [-503, "Timeout"],
    [401, "AUTH_KEY_PERM_EMPTY"],
    [303, "FILE_MIGRATE_%d"],
    [420, "FLOOD_TEST_PHONE_WAIT_%d"],
    [404, "NOT_FOUND"],
    [502, "BAD_GATEWAY"],
  ]
  for (const [code, text] of others) {
    test(`error ${code} ${text} is uncertain`, () => {
      uncertain(answered(code, text))
    })
  }

  test("a session that ended is uncertain, not a refusal", () => {
    for (const text of ["SESSION_REVOKED", "AUTH_KEY_UNREGISTERED", "USER_DEACTIVATED"]) uncertain(answered(401, text))
  })

  test("an error that is not Telegram's is uncertain and says nothing of its message", () => {
    const failure = uncertain(new Error("socket to +15550100123 broke"))

    expect(failure.message).not.toContain("15550100123")
  })

  test("a call that was abandoned says so", () => {
    expect(
      uncertain(new DOMException("aborted", "AbortError"), { reconnected: false, aborted: true }).message,
    ).toContain("cancelled")
  })

  test("every refusal after a reconnect is uncertain", () => {
    const refusals = [
      answered(420, "FLOOD_WAIT_30"),
      answered(403, "CHAT_WRITE_FORBIDDEN"),
      answered(400, "PEER_ID_INVALID"),
      answered(400, "MESSAGE_TOO_LONG"),
      answered(400, "SOMETHING_NEW"),
    ]
    for (const refusal of refusals) {
      expect(uncertain(refusal, RECONNECTED).message).toContain(String(refusal.text))
    }
  })

  test("RANDOM_ID_DUPLICATE is told apart before any failure is judged", () => {
    expect(isRandomIdDuplicate(answered(400, "RANDOM_ID_DUPLICATE"))).toBe(true)
    expect(isRandomIdDuplicate(answered(400, "MESSAGE_EMPTY"))).toBe(false)
    expect(isRandomIdDuplicate(new Error("RANDOM_ID_DUPLICATE"))).toBe(false)
  })
})

describe("the message found in a response", () => {
  const randomId = Long.fromString("1234567890123456789")
  const mine = (id: number, message = "mine") =>
    fakeMessage({ id, out: true, peerId: channelPeer(), message, date: FAKE_DATE + 7 })
  const group = (updates: tl.TypeUpdate[], _: "updates" | "updatesCombined" = "updates") =>
    ({
      _,
      updates,
      users: [fakeUser(), fakeSelf()],
      chats: [fakeSupergroup()],
      date: 0,
      seq: 0,
      ...(_ === "updatesCombined" ? { seqStart: 0 } : {}),
    }) as tl.TypeUpdates
  const named = (id: number, who = randomId): tl.TypeUpdate => ({ _: "updateMessageID", id, randomId: who })
  const arrived = (message: tl.RawMessage): tl.TypeUpdate => ({
    _: "updateNewChannelMessage",
    message,
    pts: 1,
    ptsCount: 1,
  })

  test("the short form gives the id and the time, in milliseconds", () => {
    const short: tl.RawUpdateShortSentMessage = {
      _: "updateShortSentMessage",
      id: 9,
      pts: 1,
      ptsCount: 1,
      date: FAKE_DATE,
      ttlPeriod: 60,
    }

    expect(sentMessageOf(short, randomId)).toEqual({
      form: "short",
      id: 9,
      date: FAKE_DATE * 1000,
      ttl: 60,
      entities: [],
    })
  })

  test("the message the matching update names is the one taken, whatever order the group holds", () => {
    const response = group([arrived(mine(4, "another")), named(5), arrived(mine(5)), arrived(mine(6, "later"))])

    const sent = sentMessageOf(response, randomId)

    expect(sent).toMatchObject({ form: "full", id: 5, date: (FAKE_DATE + 7) * 1000 })
    expect(sent?.form === "full" && sent.message.text).toBe("mine")
  })

  test("a combined group is read too", () => {
    expect(sentMessageOf(group([named(5), arrived(mine(5))], "updatesCombined"), randomId)).toMatchObject({ id: 5 })
  })

  test("a group whose id update carries another random id has no message of ours", () => {
    const response = group([named(5, Long.fromString("42")), arrived(mine(5))])

    expect(sentMessageOf(response, randomId)).toBeUndefined()
  })

  test("a group without an id update has none, however many new messages it holds", () => {
    expect(sentMessageOf(group([arrived(mine(5))]), randomId)).toBeUndefined()
  })

  test("a group whose named message never arrived has none", () => {
    expect(sentMessageOf(group([named(5), arrived(mine(6))]), randomId)).toBeUndefined()
  })

  test("a response of another kind has none", () => {
    const short: tl.TypeUpdates = { _: "updatesTooLong" }
    const one: tl.TypeUpdates = { _: "updateShort", update: named(5), date: 0 }

    expect(sentMessageOf(short, randomId)).toBeUndefined()
    expect(sentMessageOf(one, randomId)).toBeUndefined()
  })
})
