import { describe, expect, test } from "bun:test"
import { resolveSendDirs } from "./send-dirs"
import { failure } from "./settings.testing"

const given = (...texts: string[]) => texts.map((text) => ({ text, source: "DEMO_SEND_DIRS" }))

describe("resolveSendDirs", () => {
  test("is empty when none are given", () => {
    expect(resolveSendDirs([], { HOME: "/home/user" })).toEqual([])
  })

  test("returns each absolute path, resolved, in order", () => {
    expect(resolveSendDirs(given("/var/a/../a", "/var/b"), {})).toEqual(["/var/a", "/var/b"])
  })

  test("expands ~ and ~/x against the home directory", () => {
    expect(resolveSendDirs(given("~", "~/shared"), { HOME: "/home/user" })).toEqual(["/home/user", "/home/user/shared"])
  })

  test("refuses a relative, ~user or blank entry, naming the source", () => {
    for (const text of ["relative/path", "~otheruser/files", "   "]) {
      const error = failure(() => resolveSendDirs(given("/ok", text), { HOME: "/home/user" }))
      expect(error.message).toContain("DEMO_SEND_DIRS")
      expect(error.message).toContain("must be an absolute path")
    }
  })
})
