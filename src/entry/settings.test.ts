import { describe, expect, test } from "bun:test"
import { PROJECT } from "../project"
import type { EntryProfile } from "./profile"
import { forwardedVariables, parseSettings, parseToolSettings, settingVariables } from "./settings"
import { FILE_SETTINGS, failure, profile } from "./settings.testing"

const parse = (argv: string[], env: Record<string, string | undefined> = {}) => parseSettings(argv, env, profile)
const parseTool = (argv: string[], env: Record<string, string | undefined> = {}) =>
  parseToolSettings(argv, env, profile)

describe("settingVariables", () => {
  test("names each setting's variable under the profile's prefix", () => {
    expect(settingVariables(profile)).toEqual([
      "DEMO_TOOLSETS",
      "DEMO_READ_ONLY",
      "DEMO_TOOLS",
      "DEMO_EXCLUDE_TOOLS",
      "DEMO_CONFIRM",
      "DEMO_STATE_DIR",
      "DEMO_DOWNLOAD_DIR",
      "DEMO_DOWNLOAD_MAX_MB",
      "DEMO_SEND_DIRS",
      "DEMO_KEEP_DISAPPEARING",
      "DEMO_CHANNELS",
      "DEMO_NOTE_TEXT",
    ])
  })

  test("uses the package's own prefix by default", () => {
    expect(settingVariables()).toEqual(
      settingVariables({ ...profile, envPrefix: PROJECT.envPrefix, options: PROJECT.options }),
    )
  })
})

describe("forwardedVariables", () => {
  test("lists the settings' variables, then the tool variables", () => {
    expect(forwardedVariables(profile, ["XDG_STATE_HOME"])).toEqual([...settingVariables(profile), "XDG_STATE_HOME"])
  })

  test("uses the package's own prefix and toolVariables by default", () => {
    expect(forwardedVariables()).toEqual([...settingVariables(), ...PROJECT.toolVariables])
  })
})

describe("parseSettings", () => {
  test("defaults to the harness confirming and no other setting", () => {
    expect(parse([])).toEqual({ confirm: "harness", options: {}, state_dir: expect.any(String), ...FILE_SETTINGS })
  })

  test("reads each flag", () => {
    expect(
      parse([
        "--toolsets",
        "alpha,beta",
        "--read-only",
        "--tools",
        "demo_thing_read",
        "--exclude-tools",
        "demo_thing_merge",
        "--confirm",
        "elicitation",
        "--state-dir",
        "/custom/state",
      ]),
    ).toEqual({
      toolsets: ["alpha", "beta"],
      read_only: true,
      tools: ["demo_thing_read"],
      exclude_tools: ["demo_thing_merge"],
      confirm: "elicitation",
      options: { state_dir: "/custom/state" },
      state_dir: "/custom/state",
      ...FILE_SETTINGS,
    })
  })

  test("reads the --flag=value form", () => {
    expect(
      parse([
        "--toolsets=gamma",
        "--tools=a,b",
        "--exclude-tools=c",
        "--confirm=elicitation",
        "--read-only",
        "--state-dir=/custom/state",
      ]),
    ).toEqual({
      toolsets: ["gamma"],
      tools: ["a", "b"],
      exclude_tools: ["c"],
      read_only: true,
      confirm: "elicitation",
      options: { state_dir: "/custom/state" },
      state_dir: "/custom/state",
      ...FILE_SETTINGS,
    })
  })

  test("falls back to the environment", () => {
    expect(
      parse([], {
        DEMO_TOOLSETS: "beta,gamma",
        DEMO_READ_ONLY: "true",
        DEMO_TOOLS: "x",
        DEMO_EXCLUDE_TOOLS: "y,z",
        DEMO_CONFIRM: "elicitation",
        DEMO_STATE_DIR: "/env/state",
      }),
    ).toEqual({
      toolsets: ["beta", "gamma"],
      read_only: true,
      tools: ["x"],
      exclude_tools: ["y", "z"],
      confirm: "elicitation",
      options: { state_dir: "/env/state" },
      state_dir: "/env/state",
      ...FILE_SETTINGS,
    })
  })

  test("names its environment variables after the package's prefix unless given a profile", () => {
    const variable = `${PROJECT.envPrefix}_READ_ONLY`
    expect(parseSettings([], { [variable]: "true" }).read_only).toBe(true)
    expect(parseSettings([], { DEMO_READ_ONLY: "true" }).read_only).toBeUndefined()
    expect(parse([], { [variable]: "true" }).read_only).toBeUndefined()
    expect(failure(() => parseSettings([], { [variable]: "yes" })).message).toContain(variable)
  })

  test.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["0", false],
    ["False", false],
  ])("DEMO_READ_ONLY=%s is %p", (value, expected) => {
    expect(parse([], { DEMO_READ_ONLY: value }).read_only).toBe(expected)
  })

  test.each(["yes", "on", "2", "enabled"])("DEMO_READ_ONLY=%s is rejected, naming the variable", (value) => {
    const message = failure(() => parse([], { DEMO_READ_ONLY: value })).message
    expect(message).toContain("DEMO_READ_ONLY")
    expect(message).toContain(`"${value}"`)
  })

  test("a flag-given --read-only is not blocked by a bad environment variable it overrides", () => {
    expect(parse(["--read-only"], { DEMO_READ_ONLY: "yes" }).read_only).toBe(true)
  })

  test("a flag wins over its environment variable", () => {
    const env = {
      DEMO_TOOLSETS: "gamma",
      DEMO_TOOLS: "x",
      DEMO_EXCLUDE_TOOLS: "y",
      DEMO_CONFIRM: "elicitation",
      DEMO_READ_ONLY: "0",
      DEMO_STATE_DIR: "/env/state",
    }
    expect(
      parse(
        [
          "--toolsets",
          "alpha",
          "--tools",
          "a",
          "--exclude-tools",
          "b",
          "--confirm",
          "harness",
          "--read-only",
          "--state-dir",
          "/flag/state",
        ],
        env,
      ),
    ).toEqual({
      toolsets: ["alpha"],
      tools: ["a"],
      exclude_tools: ["b"],
      confirm: "harness",
      read_only: true,
      options: { state_dir: "/flag/state" },
      state_dir: "/flag/state",
      ...FILE_SETTINGS,
    })
  })

  test("an empty environment variable counts as unset", () => {
    expect(parse([], { DEMO_TOOLSETS: "", DEMO_CONFIRM: " " })).toEqual({
      confirm: "harness",
      options: {},
      state_dir: expect.any(String),
      ...FILE_SETTINGS,
    })
  })

  test("rejects a relative state_dir in flag or environment", () => {
    expect(failure(() => parse(["--state-dir", "rel/path"])).message).toContain("--state-dir")
    expect(failure(() => parse([], { DEMO_STATE_DIR: "rel/path" })).message).toContain("DEMO_STATE_DIR")
  })

  test("drops empty list items", () => {
    const settings = parse(["--toolsets", "alpha,,beta,", "--tools", ",a, ,b"])
    expect(settings.toolsets).toEqual(["alpha", "beta"])
    expect(settings.tools).toEqual(["a", "b"])
    expect(parse(["--toolsets", ","]).toolsets).toBeUndefined()
  })

  test('"all" turns on every toolset', () => {
    expect(parse(["--toolsets", "all"]).toolsets).toBe("all")
    expect(parse([], { DEMO_TOOLSETS: "all" }).toolsets).toBe("all")
  })

  test("the last of a repeated flag wins", () => {
    expect(parse(["--confirm", "elicitation", "--confirm=harness"]).confirm).toBe("harness")
  })

  test("an unknown flag or a stray argument is rejected, naming it", () => {
    expect(failure(() => parse(["--nope"])).message).toContain("--nope")
    expect(failure(() => parse(["--nope=1"])).message).toContain("--nope=1")
    expect(failure(() => parse(["alpha"])).message).toContain("alpha")
  })

  test("a flag without a value is rejected, naming it", () => {
    expect(failure(() => parse(["--toolsets"])).message).toContain("--toolsets")
    expect(failure(() => parse(["--tools", "--read-only"])).message).toContain("--tools")
    expect(failure(() => parse(["--read-only=1"])).message).toContain("--read-only")
  })

  test("a bad confirm mode is rejected, naming it", () => {
    expect(failure(() => parse(["--confirm", "ask"])).message).toContain('"ask"')
    expect(failure(() => parse([], { DEMO_CONFIRM: "ask" })).message).toContain("DEMO_CONFIRM")
  })

  test("an unknown toolset is rejected, naming it, where it came from and the toolsets there are", () => {
    const fromFlag = failure(() => parse(["--toolsets", "alpha,bogus"])).message
    expect(fromFlag).toContain('"bogus"')
    expect(fromFlag).toContain("--toolsets")
    for (const name of profile.toolsets.names) expect(fromFlag).toContain(name)
    expect(failure(() => parse([], { DEMO_TOOLSETS: "bogus" })).message).toContain("DEMO_TOOLSETS")
  })

  test("with no toolsets defined, a named toolset is rejected and the message says so", () => {
    const none: EntryProfile = { name: "demo-tools", envPrefix: "DEMO", toolsets: { names: [], defaults: [] } }
    expect(failure(() => parseSettings(["--toolsets", "alpha"], {}, none)).message).toContain("no toolsets are defined")
    expect(parseSettings(["--toolsets", "all"], {}, none).toolsets).toBe("all")
  })
})

describe("keep_disappearing and channels", () => {
  test("are absent from the options unless set", () => {
    expect(parse([]).options).toEqual({})
  })

  test("read from the flags, the environment, and the flag wins", () => {
    expect(parse(["--keep-disappearing", "--channels"]).options).toEqual({ keep_disappearing: true, channels: true })
    expect(parse([], { DEMO_KEEP_DISAPPEARING: "1", DEMO_CHANNELS: "true" }).options).toEqual({
      keep_disappearing: true,
      channels: true,
    })
    expect(parse([], { DEMO_CHANNELS: "0" }).options.channels).toBe(false)
    expect(parse(["--channels"], { DEMO_CHANNELS: "0" }).options.channels).toBe(true)
  })

  test("a bad environment value is rejected, naming the variable; a value after the flag is too", () => {
    expect(failure(() => parse([], { DEMO_CHANNELS: "yes" })).message).toContain("DEMO_CHANNELS")
    expect(failure(() => parse(["--channels=1"])).message).toContain("--channels")
  })

  test("parseToolSettings reads them too", () => {
    expect(parseTool(["--channels"], { DEMO_KEEP_DISAPPEARING: "true" }).options).toEqual({
      keep_disappearing: true,
      channels: true,
    })
  })
})

describe("parseToolSettings", () => {
  test("reads the tool settings and gives no confirm setting", () => {
    expect(parseTool([])).toEqual({ options: {}, state_dir: expect.any(String), ...FILE_SETTINGS })
    expect(
      parseTool(["--toolsets=gamma", "--read-only", "--tools", "a", "--state-dir=/tool/state"], {
        DEMO_EXCLUDE_TOOLS: "b",
      }),
    ).toEqual({
      toolsets: ["gamma"],
      read_only: true,
      tools: ["a"],
      exclude_tools: ["b"],
      options: { state_dir: "/tool/state" },
      state_dir: "/tool/state",
      ...FILE_SETTINGS,
    })
  })

  test("rejects --confirm in both forms, naming it", () => {
    expect(failure(() => parseTool(["--confirm", "harness"])).message).toContain("--confirm")
    expect(failure(() => parseTool(["--confirm=elicitation"])).message).toContain("--confirm")
  })

  test("ignores DEMO_CONFIRM, even a bad one", () => {
    expect(parseTool([], { DEMO_CONFIRM: "ask" })).toEqual({
      options: {},
      state_dir: expect.any(String),
      ...FILE_SETTINGS,
    })
  })
})
