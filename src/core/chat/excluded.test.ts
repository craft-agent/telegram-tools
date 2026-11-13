import { describe, expect, test } from "bun:test"
import { ToolError } from "../errors"
import { excludedChats, excludedCondition, refuseExcludedChats } from "./excluded"

describe("excluded chats", () => {
  test("defaults to none and keeps distinct canonical ids without rounding", () => {
    expect([...excludedChats({})]).toEqual([])
    expect([...excludedChats({ options: { exclude_chats: ["123", "-1001234567890", "123"] } })]).toEqual([
      "123",
      "-1001234567890",
    ])
  })

  test.each(["0", "-0", "01", "-01", "+1", " 1", "1 ", "1.0", "1e3", "", "@private"])(
    "refuses noncanonical setting entry %j without showing it",
    (chat) => {
      expect(() => excludedChats({ options: { exclude_chats: [chat] } })).toThrow(
        new ToolError(
          "invalid_argument",
          "The exclude_chats setting holds an entry that is not a chat id; set it to chat ids as list gives them.",
        ),
      )
    },
  )

  test("refuses malformed setting types, too", () => {
    expect(() => excludedChats({ options: { exclude_chats: "private" } })).toThrow(ToolError)
  })

  test("returns the supplied refusal for the first excluded argument", () => {
    const refusal = new ToolError("not_found", "unknown")
    const ctx = { options: { exclude_chats: ["2", "1"] } }
    expect(() => refuseExcludedChats(ctx, ["3"], () => refusal)).not.toThrow()
    expect(() =>
      refuseExcludedChats(ctx, ["1", "2"], (chat) => {
        expect(chat).toBe("1")
        return refusal
      }),
    ).toThrow(refusal)
  })

  test("builds a parameterized SQL condition only when needed", () => {
    expect(excludedCondition("m.chat", new Set())).toBeUndefined()
    expect(excludedCondition("m.chat", new Set(["123", "-456"]))).toEqual({
      sql: "m.chat NOT IN (?, ?)",
      params: ["123", "-456"],
    })
  })
})
