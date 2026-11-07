import { describe, expect, test } from "bun:test"
import { isToolError } from "../errors"
import { FAKE_IDS, FAKE_PHONE } from "./fake-telegram.testing"
import { loginByPhone } from "./login"
import {
  createFakeLoginClient,
  createFakeLoginIo,
  fakeAccount,
  fakeSentCode,
  floodWait,
  rpcError,
} from "./login.testing"

const ME = { id: String(FAKE_IDS.me), name: fakeAccount().displayName }

async function failureOf(run: Promise<unknown>) {
  try {
    await run
  } catch (error) {
    return error
  }
  throw new Error("expected a failure")
}

function codeFlow(...signIn: unknown[]) {
  return createFakeLoginClient()
    .script("sendCode", fakeSentCode("hash-9"))
    .script("signIn", ...(signIn as never[]))
}

describe("loginByPhone", () => {
  test("asks the number visibly, then the code, and returns the account", async () => {
    const io = createFakeLoginIo([` ${FAKE_PHONE} `, "12345"])
    const client = codeFlow(fakeAccount())
    expect(await loginByPhone(client, io)).toEqual(ME)
    expect(client.argsOf("sendCode")[0]).toMatchObject({ phone: FAKE_PHONE, abortSignal: io.signal })
    expect(client.argsOf("signIn")[0]).toMatchObject({ phone: FAKE_PHONE, phoneCodeHash: "hash-9", phoneCode: "12345" })
    expect(io.hiddenPrompts).toEqual([])
  })

  test("takes a user back from sendCode as success without asking a code", async () => {
    const io = createFakeLoginIo([FAKE_PHONE])
    const client = createFakeLoginClient().script("sendCode", fakeAccount())
    expect(await loginByPhone(client, io)).toEqual(ME)
    expect(client.argsOf("signIn")).toEqual([])
  })

  test("asks a wrong code again, up to three times in all", async () => {
    const io = createFakeLoginIo([FAKE_PHONE, "1", "2", "3"])
    const client = codeFlow(rpcError(400, "PHONE_CODE_INVALID"), rpcError(400, "PHONE_CODE_INVALID"), fakeAccount())
    expect(await loginByPhone(client, io)).toEqual(ME)
    expect(client.argsOf("signIn")).toHaveLength(3)
  })

  test("fails as invalid_argument after three wrong codes", async () => {
    const io = createFakeLoginIo([FAKE_PHONE, "1", "2", "3"])
    const wrong = rpcError(400, "PHONE_CODE_INVALID")
    const error = await failureOf(loginByPhone(codeFlow(wrong, wrong, wrong), io))
    expect(isToolError(error) && error.code).toBe("invalid_argument")
  })

  test("fails as invalid_argument when the code expired", async () => {
    const io = createFakeLoginIo([FAKE_PHONE, "1"])
    const error = await failureOf(loginByPhone(codeFlow(rpcError(400, "PHONE_CODE_EXPIRED")), io))
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    expect((error as Error).message).toBe("The code expired; log in again.")
  })

  test("asks the two-step password without echo when Telegram needs it", async () => {
    const io = createFakeLoginIo([FAKE_PHONE, "1"], ["secret"])
    const client = codeFlow(rpcError(401, "SESSION_PASSWORD_NEEDED")).script("checkPassword", fakeAccount())
    expect(await loginByPhone(client, io)).toEqual(ME)
    expect(client.argsOf("checkPassword")[0]).toMatchObject({ password: "secret" })
    expect(io.hiddenPrompts).toHaveLength(1)
  })

  test("asks a wrong password again, and fails after three", async () => {
    const io = createFakeLoginIo([FAKE_PHONE, "1"], ["a", "b", "c"])
    const wrong = rpcError(400, "PASSWORD_HASH_INVALID")
    const client = codeFlow(rpcError(401, "SESSION_PASSWORD_NEEDED")).script("checkPassword", wrong, wrong, wrong)
    const error = await failureOf(loginByPhone(client, io))
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    expect(io.hiddenPrompts).toHaveLength(3)
  })

  test.each(["PHONE_NUMBER_INVALID", "PHONE_NUMBER_BANNED", "PHONE_NUMBER_UNOCCUPIED"])(
    "maps %s to invalid_argument",
    async (text) => {
      const client = createFakeLoginClient().script("sendCode", rpcError(400, text))
      const error = await failureOf(loginByPhone(client, createFakeLoginIo([FAKE_PHONE])))
      expect(isToolError(error) && error.code).toBe("invalid_argument")
    },
  )

  test("maps a flood wait to rate_limited", async () => {
    const client = createFakeLoginClient().script("sendCode", floodWait(60))
    const error = await failureOf(loginByPhone(client, createFakeLoginIo([FAKE_PHONE])))
    expect(isToolError(error) && error.code).toBe("rate_limited")
    expect((error as Error).message).toContain("60 seconds")
  })

  test("maps another Telegram error to upstream_error with its name only", async () => {
    const client = codeFlow(rpcError(400, "PHONE_CODE_HASH_EMPTY"))
    const error = await failureOf(loginByPhone(client, createFakeLoginIo([FAKE_PHONE, "1"])))
    expect(isToolError(error) && error.code).toBe("upstream_error")
    expect((error as Error).message).toContain("(PHONE_CODE_HASH_EMPTY)")
  })

  test("rethrows an abort as it is", async () => {
    const abort = new DOMException("aborted", "AbortError")
    const error = await failureOf(loginByPhone(codeFlow(abort), createFakeLoginIo([FAKE_PHONE, "1"])))
    expect(error).toBe(abort)
  })

  test("never puts the phone number in a line, an error or the result", async () => {
    const digits = FAKE_PHONE.slice(1)
    const cases: Array<[string[], unknown[]]> = [
      [
        ["1", "2", "3"],
        [rpcError(400, "PHONE_CODE_INVALID"), rpcError(400, "PHONE_CODE_INVALID"), rpcError(400, "PHONE_CODE_INVALID")],
      ],
      [["1"], [rpcError(400, "PHONE_CODE_EXPIRED")]],
      [["1"], [fakeAccount()]],
      [
        ["1", "2"],
        [rpcError(400, "PHONE_CODE_INVALID"), rpcError(400, "PHONE_CODE_HASH_EMPTY")],
      ],
    ]
    for (const [codes, answers] of cases) {
      const io = createFakeLoginIo([FAKE_PHONE, ...codes])
      let outcome: string
      try {
        outcome = JSON.stringify(await loginByPhone(codeFlow(...answers), io))
      } catch (error) {
        outcome = `${(error as Error).message} ${JSON.stringify(error)}`
      }
      const seen = [outcome, ...io.said].join("\n")
      expect(seen).not.toContain(digits)
    }
  })
})
