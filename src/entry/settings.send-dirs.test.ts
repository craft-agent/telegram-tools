import { describe, expect, test } from "bun:test"
import { parseSettings, parseToolSettings, settingsFromOptions } from "./settings"
import { failure, profile } from "./settings.testing"

const parse = (argv: string[], env: Record<string, string | undefined> = {}) => parseSettings(argv, env, profile)
const fromOptions = (options: Record<string, unknown>, env: Record<string, string | undefined> = {}) =>
  settingsFromOptions(options, env, profile)

describe("the send_dirs setting", () => {
  test("is empty by default", () => {
    expect(parse([]).send_dirs).toEqual([])
    expect(fromOptions({}).send_dirs).toEqual([])
  })

  test("is comma-separated in a flag and a variable, dropping empty items", () => {
    expect(parse(["--send-dirs", "/a, /b,,"]).send_dirs).toEqual(["/a", "/b"])
    expect(parse([], { DEMO_SEND_DIRS: ",/a,/b" }).send_dirs).toEqual(["/a", "/b"])
    expect(parse([], { DEMO_SEND_DIRS: " " }).send_dirs).toEqual([])
  })

  test("expands ~ in each entry", () => {
    expect(parse(["--send-dirs", "~/a,~"], { HOME: "/home/user" }).send_dirs).toEqual(["/home/user/a", "/home/user"])
    expect(fromOptions({ send_dirs: ["~/shared"] }, { HOME: "/home/user" }).send_dirs).toEqual(["/home/user/shared"])
  })

  test("a flag wins over its variable as a whole, not item by item", () => {
    expect(parse(["--send-dirs=/flag"], { DEMO_SEND_DIRS: "/env/a,/env/b" }).send_dirs).toEqual(["/flag"])
  })

  test("refuses a relative entry, naming where it came from", () => {
    expect(failure(() => parse(["--send-dirs", "/a,rel/path"])).message).toContain("--send-dirs")
    expect(failure(() => parse([], { DEMO_SEND_DIRS: "rel/path" })).message).toContain("DEMO_SEND_DIRS")
    expect(failure(() => fromOptions({}, { DEMO_SEND_DIRS: "/a,rel" })).message).toContain("DEMO_SEND_DIRS")
  })

  test("a flag without a value is refused, naming it", () => {
    expect(failure(() => parse(["--send-dirs"])).message).toContain("--send-dirs")
  })

  test("the tool settings read it too", () => {
    expect(parseToolSettings(["--send-dirs=/a"], {}, profile).send_dirs).toEqual(["/a"])
  })

  test("a plugin option is an array of absolute paths, wins over the variable, and an empty list too", () => {
    expect(fromOptions({ send_dirs: ["/a", "/b"] }, { DEMO_SEND_DIRS: "/env" }).send_dirs).toEqual(["/a", "/b"])
    expect(fromOptions({ send_dirs: [] }, { DEMO_SEND_DIRS: "/env/a" }).send_dirs).toEqual([])
    expect(fromOptions({}, { DEMO_SEND_DIRS: "/env/a,/env/b" }).send_dirs).toEqual(["/env/a", "/env/b"])
    for (const value of ["/a,/b", [1], ["/a", "relative"]]) {
      expect(failure(() => fromOptions({ send_dirs: value })).message).toContain('"send_dirs"')
    }
  })

  test("a plugin option drops blank items", () => {
    expect(fromOptions({ send_dirs: ["/a", "", " ", "~/b"] }, { HOME: "/home/user" }).send_dirs).toEqual([
      "/a",
      "/home/user/b",
    ])
    expect(fromOptions({ send_dirs: ["", " "] }, { DEMO_SEND_DIRS: "/env" }).send_dirs).toEqual([])
  })

  test("normalizes each entry and names the option that was not absolute", () => {
    expect(parse(["--send-dirs", "/var/a/../a,/var/b"]).send_dirs).toEqual(["/var/a", "/var/b"])
    expect(failure(() => fromOptions({ send_dirs: ["/a", "~otheruser/files"] })).message).toBe(
      'Option "send_dirs" must be an absolute path.',
    )
  })
})
