import { describe, expect, test } from "bun:test"
import type { ErrorCode } from "../errors"
import { afterWriteError, detail, rpcError, ServiceErrorCode, UNCERTAIN_ADVICE } from "./service-errors"
import { failureOf, startFakeService } from "./service.testing"
import { callService } from "./service"

const EFFECTS = ["read", "write"] as const

describe("rpcError", () => {
  // These mean nothing was done, so a write is no more uncertain than a read.
  const definite: [number, ErrorCode][] = [
    [-32700, "internal_error"],
    [-32600, "internal_error"],
    [-32601, "upstream_error"],
    [-32602, "invalid_argument"],
  ]
  for (const [rpcCode, code] of definite) {
    for (const effect of EFFECTS) {
      test(`${rpcCode} is ${code} for a ${effect}`, () => {
        const error = rpcError("send", effect, rpcCode, "refused")
        expect(error).toMatchObject({ name: "ToolError", code })
        expect(error.message).toContain("send")
      })
    }
  }

  test("an unknown method tells the person to restart or update the service", () => {
    expect(rpcError("frobnicate", "read", -32601, "Method not found").message).toBe(
      "The service does not know frobnicate; restart the service, or update it if it is an older version.",
    )
  })

  // These leave the outcome open.
  for (const rpcCode of [-32603, -42, 7, undefined]) {
    test(`${rpcCode} is upstream_error for a read and uncertain for a write`, () => {
      expect(rpcError("listChats", "read", rpcCode, "boom")).toMatchObject({ code: "upstream_error" })
      const error = rpcError("send", "write", rpcCode, "boom")
      expect(error).toMatchObject({ code: "uncertain" })
      expect(error.message).toContain(UNCERTAIN_ADVICE)
      expect(error.message).toContain("send")
    })
  }

  test("a reply without a code says so", () => {
    expect(rpcError("send", "read", undefined, "").message).toBe(
      "send failed (the service answered with error without a code).",
    )
  })

  test("never carries the raw data of an error", () => {
    const error = rpcError("send", "read", -32602, "bad", { secret: "hunter2" })
    expect(error.message).not.toContain("hunter2")
  })
})

describe("a service failure", () => {
  const known: ErrorCode[] = [
    "not_found",
    "forbidden",
    "invalid_argument",
    "stale",
    "unauthenticated",
    "rate_limited",
    "declined",
    "upstream_error",
    "uncertain",
    "internal_error",
  ]
  for (const code of known) {
    for (const effect of EFFECTS) {
      if (code === "internal_error" && effect === "write") continue
      test(`with data.code ${code} is thrown as that code for a ${effect}`, () => {
        const error = rpcError("send", effect, ServiceErrorCode, "No such chat.", { code })
        expect(error).toMatchObject({ name: "ToolError", code, message: "No such chat." })
      })
    }
  }

  test("with data.code internal_error is uncertain for a write: the service may have reached Telegram", () => {
    const error = rpcError("send", "write", ServiceErrorCode, "the service failed on send", { code: "internal_error" })
    expect(error).toMatchObject({ name: "ToolError", code: "uncertain" })
    expect(error.message).toBe(`send may have taken effect (the service failed on it). ${UNCERTAIN_ADVICE}`)
  })

  test("with data.code internal_error stays internal_error for a read", () => {
    const error = rpcError("listChats", "read", ServiceErrorCode, "the service failed on listChats", {
      code: "internal_error",
    })
    expect(error).toMatchObject({ code: "internal_error", message: "the service failed on listChats" })
  })

  test("an unknown data.code is judged like any failure after the write", () => {
    for (const data of [{ code: "made_up" }, { code: 5 }, { code: "constructor" }, {}, "text", null, undefined]) {
      expect(rpcError("listChats", "read", ServiceErrorCode, "x", data)).toMatchObject({ code: "upstream_error" })
      expect(rpcError("send", "write", ServiceErrorCode, "x", data)).toMatchObject({ code: "uncertain" })
    }
  })

  test("carries the message masked and cut, and says what failed when there is none", () => {
    const error = rpcError("send", "read", ServiceErrorCode, `Cannot reach +1 555-555-0123 ${"x".repeat(500)}`, {
      code: "not_found",
    })
    expect(error.message).toStartWith("Cannot reach [number] xxx")
    expect(error.message).not.toContain("555")
    expect(error.message).toHaveLength(300)
    expect(rpcError("send", "read", ServiceErrorCode, " ", { code: "not_found" }).message).toBe("send failed.")
  })

  test("reaches the client as sent over the wire", async () => {
    const service = await startFakeService(() => ({
      error: { code: ServiceErrorCode, message: "Slow down.", data: { code: "rate_limited" } },
    }))
    try {
      const error = await failureOf(callService(service.socketPath, "send", {}, { effect: "write" }))
      expect(error).toMatchObject({ code: "rate_limited", message: "Slow down." })
    } finally {
      await service.close()
    }
  })
})

describe("detail", () => {
  test("is empty without text, and led by a colon with it", () => {
    expect(detail("")).toBe("")
    expect(detail("  \n")).toBe("")
    expect(detail(" bad request ")).toBe(": bad request")
  })

  test("replaces numbers, with or without separators", () => {
    expect(detail("call +15555550123 now")).toBe(": call [number] now")
    expect(detail("+1 555 555 0123, +1-555-555-0123")).toBe(": [number], [number]")
    expect(detail("+123456")).toBe(": [number]")
  })

  test("masks a number longer than fifteen digits whole", () => {
    expect(detail("+1234567890123456789")).toBe(": [number]")
  })

  test("leaves other text alone", () => {
    expect(detail("code 12345678, +12345, a+b")).toBe(": code 12345678, +12345, a+b")
  })

  test("cuts to 300 characters, after masking", () => {
    expect(detail("x".repeat(500))).toBe(`: ${"x".repeat(300)}`)
    expect(detail(`${"x".repeat(290)} +15555550123`)).not.toContain("555")
  })
})

describe("afterWriteError", () => {
  test("is uncertain with the advice for a write", () => {
    const error = afterWriteError("send", "write", "the connection broke")
    expect(error).toMatchObject({ code: "uncertain" })
    expect(error.message).toBe(`send may have taken effect (the connection broke). ${UNCERTAIN_ADVICE}`)
  })

  test("is upstream_error for a read", () => {
    const error = afterWriteError("listChats", "read", "the connection broke")
    expect(error).toMatchObject({ code: "upstream_error", message: "listChats failed (the connection broke)." })
  })
})
