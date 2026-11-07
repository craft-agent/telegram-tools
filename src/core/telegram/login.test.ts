import { describe, expect, test } from "bun:test"
import { serializeTelethonSession } from "@mtcute/convert"
import { randomBytes } from "node:crypto"
import { isToolError } from "../errors"
import { FAKE_IDS } from "./fake-telegram.testing"
import { importTelethon, isLoggedIn, loginByQr } from "./login"
import { createFakeLoginClient, createFakeLoginIo, fakeAccount, floodWait, rpcError } from "./login.testing"

type QrParams = Parameters<ReturnType<typeof createFakeLoginClient>["signInQr"]>[0]

const ME = { id: String(FAKE_IDS.me), name: fakeAccount().displayName }

async function failureOf(run: Promise<unknown>) {
  try {
    await run
  } catch (error) {
    return error
  }
  throw new Error("expected a failure")
}

describe("isLoggedIn", () => {
  test("is true when getMe succeeds", async () => {
    const client = createFakeLoginClient().script("getMe", fakeAccount())
    expect(await isLoggedIn(client)).toBe(true)
  })

  test.each(["AUTH_KEY_UNREGISTERED", "SESSION_PASSWORD_NEEDED"])("is false on %s", async (text) => {
    const client = createFakeLoginClient().script("getMe", rpcError(401, text))
    expect(await isLoggedIn(client)).toBe(false)
  })

  test("rethrows another Telegram error as upstream_error with its name only", async () => {
    const client = createFakeLoginClient().script("getMe", rpcError(500, "RPC_CALL_FAIL"))
    const error = await failureOf(isLoggedIn(client))
    expect(isToolError(error) && error.code).toBe("upstream_error")
    expect((error as Error).message).toContain("(RPC_CALL_FAIL)")
    expect((error as Error).message).not.toContain("Telegram API error")
  })

  test("rethrows a flood wait as rate_limited", async () => {
    const client = createFakeLoginClient().script("getMe", floodWait(42))
    const error = await failureOf(isLoggedIn(client))
    expect(isToolError(error) && error.code).toBe("rate_limited")
    expect((error as Error).message).toContain("42 seconds")
  })

  test("rethrows an error that is not Telegram's as it is", async () => {
    const boom = new Error("socket closed")
    const client = createFakeLoginClient().script("getMe", boom)
    expect(await failureOf(isLoggedIn(client))).toBe(boom)
  })
})

describe("loginByQr", () => {
  test("shows each refreshed URL and returns the account", async () => {
    const io = createFakeLoginIo()
    const client = createFakeLoginClient().script("signInQr", (params: QrParams) => {
      params.onUrlUpdated("tg://login?token=one", new Date(0))
      params.onUrlUpdated("tg://login?token=two", new Date(0))
      return fakeAccount()
    })
    expect(await loginByQr(client, io)).toEqual(ME)
    expect(io.qrs).toEqual(["tg://login?token=one", "tg://login?token=two"])
    expect((client.argsOf("signInQr")[0] as QrParams).abortSignal).toBe(io.signal)
  })

  test("asks the password without echo, and again when it is wrong", async () => {
    const io = createFakeLoginIo([], ["wrong", "right"])
    const client = createFakeLoginClient().script("signInQr", async (params: QrParams) => {
      const password = params.password as () => Promise<string>
      if ((await password()) !== "right") await params.invalidPasswordCallback?.()
      expect(await password()).toBe("right")
      return fakeAccount()
    })
    expect(await loginByQr(client, io)).toEqual(ME)
    expect(io.hiddenPrompts).toHaveLength(2)
  })

  test("fails as invalid_argument after three wrong passwords", async () => {
    const io = createFakeLoginIo([], ["a", "b", "c"])
    const client = createFakeLoginClient().script("signInQr", async (params: QrParams) => {
      for (;;) {
        await (params.password as () => Promise<string>)()
        await params.invalidPasswordCallback?.()
      }
    })
    const error = await failureOf(loginByQr(client, io))
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    expect(io.hiddenPrompts).toHaveLength(3)
  })

  test("maps a flood wait to rate_limited", async () => {
    const client = createFakeLoginClient().script("signInQr", floodWait(7))
    const error = await failureOf(loginByQr(client, createFakeLoginIo()))
    expect(isToolError(error) && error.code).toBe("rate_limited")
    expect((error as Error).message).toBe("Telegram asks to wait 7 seconds before logging in again.")
  })

  test("maps a code-420 error without a wait to rate_limited", async () => {
    const client = createFakeLoginClient().script("signInQr", rpcError(420, "SLOWMODE_WAIT_%d"))
    const error = await failureOf(loginByQr(client, createFakeLoginIo()))
    expect(isToolError(error) && error.code).toBe("rate_limited")
  })

  test("rethrows an abort as it is", async () => {
    const io = createFakeLoginIo()
    const abort = new DOMException("aborted", "AbortError")
    const client = createFakeLoginClient().script("signInQr", abort)
    expect(await failureOf(loginByQr(client, io))).toBe(abort)
  })

  test("maps another Telegram error to upstream_error with its name only", async () => {
    const client = createFakeLoginClient().script("signInQr", rpcError(400, "API_ID_INVALID"))
    const error = await failureOf(loginByQr(client, createFakeLoginIo()))
    expect(isToolError(error) && error.code).toBe("upstream_error")
    expect((error as Error).message).toContain("(API_ID_INVALID)")
  })
})

describe("importTelethon", () => {
  const key = randomBytes(256)
  const session = serializeTelethonSession({
    dcId: 2,
    ipAddress: "127.0.0.2",
    ipv6: false,
    port: 443,
    authKey: new Uint8Array(key),
  })

  test("converts the string, imports it with force and returns the account", async () => {
    const client = createFakeLoginClient().script("importSession", undefined).script("getMe", fakeAccount())
    expect(await importTelethon(client, `  ${session}\n`)).toEqual(ME)
    const [data, force] = client.argsOf("importSession")[0] as [{ primaryDcs: { main: { id: number } } }, boolean]
    expect(data.primaryDcs.main.id).toBe(2)
    expect(force).toBe(true)
  })

  test("rejects a malformed string without echoing it", async () => {
    const client = createFakeLoginClient()
    const error = await failureOf(importTelethon(client, "not-a-session-SECRET"))
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    expect((error as Error).message).not.toContain("SECRET")
    expect(client.calls).toEqual([])
  })

  test.each(["AUTH_KEY_UNREGISTERED", "SESSION_REVOKED", "USER_DEACTIVATED", "USER_DEACTIVATED_BAN"])(
    "maps %s to unauthenticated",
    async (text) => {
      const client = createFakeLoginClient().script("importSession", undefined).script("getMe", rpcError(401, text))
      const error = await failureOf(importTelethon(client, session))
      expect(isToolError(error) && error.code).toBe("unauthenticated")
      expect((error as Error).message).toBe("Telegram does not accept this session.")
    },
  )

  test("maps a flood wait to rate_limited", async () => {
    const client = createFakeLoginClient().script("importSession", undefined).script("getMe", floodWait(3))
    const error = await failureOf(importTelethon(client, session))
    expect(isToolError(error) && error.code).toBe("rate_limited")
  })
})
