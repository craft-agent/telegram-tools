import { describe, expect, test } from "bun:test"
import { parseServiceSettings, parseStateDir } from "./command-settings"
import { failure, profile } from "./settings.testing"

const parseService = (argv: string[], env: Record<string, string | undefined> = {}) =>
  parseServiceSettings(argv, env, profile)

describe("parseServiceSettings", () => {
  test("gives the state directory and both booleans, off by default", () => {
    expect(parseService([])).toEqual({ state_dir: expect.any(String), keep_disappearing: false, channels: false })
    expect(parseService(["--state-dir=/s", "--channels"], { DEMO_KEEP_DISAPPEARING: "1" })).toEqual({
      state_dir: "/s",
      keep_disappearing: true,
      channels: true,
    })
  })

  test("reads each setting from a variable too, and a flag wins", () => {
    expect(parseService([], { DEMO_STATE_DIR: "~/s", DEMO_CHANNELS: "true", HOME: "/home/user" })).toEqual({
      state_dir: "/home/user/s",
      keep_disappearing: false,
      channels: true,
    })
    expect(parseService(["--channels"], { DEMO_CHANNELS: "0" }).channels).toBe(true)
    expect(parseService([], { DEMO_CHANNELS: "0" }).channels).toBe(false)
  })

  test("rejects a bad value, naming where it came from", () => {
    expect(failure(() => parseService([], { DEMO_CHANNELS: "yes" })).message).toContain("DEMO_CHANNELS")
    expect(failure(() => parseService(["--keep-disappearing=1"])).message).toContain("--keep-disappearing")
    expect(failure(() => parseService(["--state-dir=rel"])).message).toBe("--state-dir must be an absolute path.")
  })

  test("rejects any other settings flag, naming it", () => {
    expect(failure(() => parseService(["--read-only"])).message).toBe('Unknown option "--read-only".')
    expect(failure(() => parseService(["--nope"])).message).toBe('Unknown option "--nope".')
    for (const flag of ["--download-dir=/received", "--download-max-mb=1", "--send-dirs=/a"]) {
      expect(failure(() => parseService([flag])).message).toBe(`Unknown option "${flag}".`)
    }
  })

  test("rejects a tool option flag too, and ignores its variable and those of the settings it does not take", () => {
    expect(failure(() => parseService(["--note-text", "x"])).message).toBe('Unknown option "--note-text".')
    const ignored = { DEMO_NOTE_TEXT: "x", DEMO_DOWNLOAD_DIR: "relative", DEMO_DOWNLOAD_MAX_MB: "bad" }
    expect(parseService([], ignored)).toEqual({
      state_dir: expect.any(String),
      keep_disappearing: false,
      channels: false,
    })
  })
})

describe("parseStateDir", () => {
  const parseState = (argv: string[], env: Record<string, string | undefined> = {}) => parseStateDir(argv, env, profile)

  test("gives the state directory from the flag, else the variable, else the default", () => {
    expect(parseState(["--state-dir", "/flag"], { DEMO_STATE_DIR: "/env" })).toBe("/flag")
    expect(parseState([], { DEMO_STATE_DIR: "/env" })).toBe("/env")
    expect(parseState([], { HOME: "/home/user" })).toBe("/home/user/.local/state/demo-tools")
  })

  test("rejects every other settings flag, naming it, and ignores their variables", () => {
    for (const flag of ["--channels", "--keep-disappearing", "--note-text=x", "--download-dir=/received"]) {
      expect(failure(() => parseState([flag])).message).toBe(`Unknown option "${flag}".`)
    }
    const ignored = { DEMO_CHANNELS: "yes", DEMO_DOWNLOAD_DIR: "relative", DEMO_NOTE_TEXT: "x" }
    expect(parseState([], { ...ignored, DEMO_STATE_DIR: "/env" })).toBe("/env")
  })
})
