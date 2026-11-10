import { Long, tl } from "@mtcute/core"
import { describe, expect, test } from "bun:test"
import type { ErrorCode } from "../errors"
import { FAKE_DATE, channelPeer, fakeMessage, fakeSelf, fakeSupergroup, fakeUser } from "./fake-telegram.testing"
import { answered } from "./sync-client-send.testing"
import { sendFailureOf, sentFilesOf } from "./sync-send-outcome"

const CALM = { reconnected: false, aborted: false }
const FIRST = Long.fromString("1111111111111111111")
const SECOND = Long.fromString("2222222222222222222")
const THIRD = Long.fromString("3333333333333333333")

describe("the refusals of a file send", () => {
  const refusals: [string, number, ErrorCode, string][] = [
    ["MEDIA_CAPTION_TOO_LONG", 400, "invalid_argument", "Telegram refused the caption"],
    ["CHAT_SEND_MEDIA_FORBIDDEN", 403, "forbidden", "Telegram does not let this account send here"],
    ["CHAT_SEND_DOCS_FORBIDDEN", 403, "forbidden", "Telegram does not let this account send here"],
  ]
  for (const [name, status, code, what] of refusals) {
    test(`${name} is ${code}, and nothing was sent`, () => {
      const failure = sendFailureOf(answered(status, name), CALM)

      expect(failure.code).toBe(code)
      expect(failure.message).toBe(`${what} (${name}); nothing was sent.`)
    })

    test(`${name} after a reconnect is uncertain`, () => {
      expect(sendFailureOf(answered(status, name), { reconnected: true, aborted: false }).code).toBe("uncertain")
    })
  }
})

describe("the messages found in the response to a file send", () => {
  const mine = (id: number) =>
    fakeMessage({ id, out: true, peerId: channelPeer(), message: `file ${id}`, date: FAKE_DATE + 7 })
  const named = (id: number, randomId: Long): tl.TypeUpdate => ({ _: "updateMessageID", id, randomId })
  const arrived = (id: number): tl.TypeUpdate => ({
    _: "updateNewChannelMessage",
    message: mine(id),
    pts: id,
    ptsCount: 1,
  })
  const group = (updates: tl.TypeUpdate[]): tl.TypeUpdates => ({
    _: "updates",
    updates,
    users: [fakeUser(), fakeSelf()],
    chats: [fakeSupergroup()],
    date: 0,
    seq: 0,
  })

  test("are one for each random id, in the order of the random ids, whatever order the group holds", () => {
    const response = group([arrived(6), named(6, SECOND), arrived(5), named(5, FIRST), named(7, THIRD), arrived(7)])

    const found = sentFilesOf(response, [FIRST, SECOND, THIRD])

    expect(found?.map(({ id, form }) => ({ id, form }))).toEqual([
      { id: 5, form: "full" },
      { id: 6, form: "full" },
      { id: 7, form: "full" },
    ])
    expect(found?.[0]?.date).toBe((FAKE_DATE + 7) * 1000)
  })

  test("are none when one random id is not named", () => {
    const response = group([named(5, FIRST), arrived(5), arrived(6)])

    expect(sentFilesOf(response, [FIRST, SECOND])).toBeUndefined()
  })

  test("are none when a named message never arrived", () => {
    const response = group([named(5, FIRST), named(6, SECOND), arrived(5)])

    expect(sentFilesOf(response, [FIRST, SECOND])).toBeUndefined()
  })

  test("are none in the short form or a response of another kind, which hold no file", () => {
    const short: tl.TypeUpdates = { _: "updateShortSentMessage", id: 9, pts: 1, ptsCount: 1, date: FAKE_DATE }

    expect(sentFilesOf(short, [FIRST])).toBeUndefined()
    expect(sentFilesOf({ _: "updatesTooLong" }, [FIRST])).toBeUndefined()
  })
})
