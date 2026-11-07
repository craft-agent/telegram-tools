import { describe, expect, test } from "bun:test"
import { ToolError } from "./errors"
import { formatLocalTime, localOffsetMinutes, localTimeSchema, parseTimeArgument } from "./time"

const INSTANT = Date.UTC(2026, 10, 7, 5, 3, 12, 345)
const at = (minutes: number) => () => minutes

describe("formatLocalTime", () => {
  test.each([
    [540, "2026-11-07T14:03:12.345+09:00"],
    [-330, "2026-11-06T23:33:12.345-05:30"],
    [0, "2026-11-07T05:03:12.345+00:00"],
    [345, "2026-11-07T10:48:12.345+05:45"],
    [-570, "2026-11-06T19:33:12.345-09:30"],
  ])("offset %i minutes", (offset, expected) => {
    expect(formatLocalTime(INSTANT, at(offset))).toBe(expected)
    expect(Date.parse(expected)).toBe(INSTANT)
  })

  test("keeps the milliseconds when they are zero", () => {
    expect(formatLocalTime(Date.UTC(2026, 0, 1), at(0))).toBe("2026-01-01T00:00:00.000+00:00")
  })

  test("asks the offset at the instant it formats", () => {
    const summer = (ms: number) => (ms >= INSTANT ? 120 : 60)
    expect(formatLocalTime(INSTANT - 1, summer)).toEndWith("+01:00")
    expect(formatLocalTime(INSTANT, summer)).toEndWith("+02:00")
  })

  test("the process's own zone gives a time that reads back as the same instant and passes the schema", () => {
    const text = formatLocalTime(INSTANT)
    expect(Date.parse(text)).toBe(INSTANT)
    expect(localTimeSchema.safeParse(text).success).toBe(true)
    expect(text).not.toEndWith("Z")
    expect(localOffsetMinutes(INSTANT)).toBe(-new Date(INSTANT).getTimezoneOffset())
  })
})

/** Runs `fn` with the process's time zone set to `zone`, and puts the old one back. */
function inZone<T>(zone: string, fn: () => T): T {
  const before = process.env.TZ
  process.env.TZ = zone
  try {
    return fn()
  } finally {
    if (before === undefined) delete process.env.TZ
    else process.env.TZ = before
  }
}

describe("parseTimeArgument", () => {
  test.each([
    ["2026-11-07T14:03:12.345+09:00", INSTANT],
    ["2026-11-06T23:33:12.345-05:30", INSTANT],
    ["2026-11-07T10:48:12.345+05:45", INSTANT],
    ["2026-11-06T19:33:12.345-09:30", INSTANT],
    ["2026-11-07T05:03:12.345Z", INSTANT],
    ["2026-11-07t05:03:12.345z", INSTANT],
    ["2026-11-07 14:03:12.345+09:00", INSTANT],
    ["2026-11-07T14:03:12.3456789+09:00", INSTANT],
    ["2026-11-07T14:03+09:00", Date.UTC(2026, 10, 7, 5, 3)],
    ["2026-11-07T14:03:12.5+09:00", Date.UTC(2026, 10, 7, 5, 3, 12, 500)],
  ])("reads %s with its own offset", (text, expected) => {
    expect(parseTimeArgument(text, "after")).toBe(expected)
  })

  test.each([
    ["Asia/Tokyo", Date.UTC(2026, 10, 7, 5, 3)],
    ["Asia/Kolkata", Date.UTC(2026, 10, 7, 8, 33)],
    ["America/New_York", Date.UTC(2026, 10, 7, 19, 3)],
    ["UTC", Date.UTC(2026, 10, 7, 14, 3)],
  ])("a time without an offset is local time in %s", (zone, expected) => {
    inZone(zone, () => {
      expect(parseTimeArgument("2026-11-07T14:03", "after")).toBe(expected)
      expect(parseTimeArgument("2026-11-07T14:03:00.000", "after")).toBe(expected)
      expect(parseTimeArgument("2026-11-07 14:03", "after")).toBe(expected)
    })
  })

  test("a date alone is local midnight", () => {
    inZone("Asia/Tokyo", () => expect(parseTimeArgument(" 2026-11-07 ", "before")).toBe(Date.UTC(2026, 10, 6, 15)))
    inZone("America/New_York", () => expect(parseTimeArgument("2026-11-07", "before")).toBe(Date.UTC(2026, 10, 7, 5)))
  })

  test("a local time a clock change skips or repeats is read as Date reads it", () => {
    inZone("America/New_York", () => {
      expect(parseTimeArgument("2026-03-08T02:30", "after")).toBe(new Date(2026, 2, 8, 2, 30).getTime())
      expect(parseTimeArgument("2026-11-01T01:30", "after")).toBe(new Date(2026, 10, 1, 1, 30).getTime())
      expect(parseTimeArgument("2026-03-08T03:30", "after")).toBe(parseTimeArgument("2026-03-08T02:30", "after"))
    })
  })

  test("accepts a real leap day and the last second of a day", () => {
    expect(parseTimeArgument("2024-02-29T23:59:59.999Z", "after")).toBe(Date.UTC(2024, 1, 29, 23, 59, 59, 999))
    inZone("UTC", () => expect(parseTimeArgument("2026-12-31", "after")).toBe(Date.UTC(2026, 11, 31)))
  })

  test.each([
    "",
    "yesterday",
    "2026-11-07T",
    "2026-13-07",
    "2026-00-10",
    "2026-02-30",
    "2026-02-29",
    "2026-04-31",
    "2026-11-31T10:00",
    "0999-11-07",
    "0026-11-07",
    "2026-11-00",
    "2026-11-07T24:00",
    "2026-11-07T14:60",
    "2026-11-07T14:03:60",
    "2026-11-07T14:03+24:00",
    "2026-11-07T14:03+09:60",
    "2026-11-07+09:00",
    "2026-11-07T14:03+0900",
    "20261107",
    "2026-11-07T14:03:12.",
  ])("refuses %j, naming the argument and the forms", (text) => {
    let error: unknown
    try {
      parseTimeArgument(text, "before")
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).code).toBe("invalid_argument")
    expect((error as ToolError).message).toContain("before is not a time")
    expect((error as ToolError).message).toContain("2026-11-07T14:03:12+09:00")
  })
})
