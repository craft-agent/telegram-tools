import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { parseSettings, parseToolSettings, settingsFromOptions } from "./settings"
import { failure, profile } from "./settings.testing"

const env = { HOME: "/people/example", DEMO_DOWNLOAD_DIR: "/env/downloads", DEMO_DOWNLOAD_MAX_MB: "50" }

describe("download settings", () => {
  test("default under Downloads, without using XDG state, and to 100 MB", () => {
    expect(parseSettings([], { HOME: env.HOME, XDG_STATE_HOME: "/state" }, profile)).toMatchObject({
      download_dir: "/people/example/Downloads/demo-tools",
      download_max_mb: 100,
    })
    expect(parseSettings([], {}, profile).download_dir).toBe(resolve(homedir(), "Downloads", profile.name))
  })

  test("read environment and flags, with flags winning even over invalid environment", () => {
    expect(parseToolSettings([], env, profile)).toMatchObject({ download_dir: "/env/downloads", download_max_mb: 50 })
    expect(
      parseSettings(
        ["--download-dir", "/flag/downloads", "--download-max-mb=200"],
        {
          DEMO_DOWNLOAD_DIR: "relative",
          DEMO_DOWNLOAD_MAX_MB: "bad",
        },
        profile,
      ),
    ).toMatchObject({ download_dir: "/flag/downloads", download_max_mb: 200 })
  })

  test("options win over environment and expand tilde like flags and environment", () => {
    expect(settingsFromOptions({ download_dir: "~/received", download_max_mb: 1 }, env, profile)).toMatchObject({
      download_dir: "/people/example/received",
      download_max_mb: 1,
    })
    expect(settingsFromOptions({}, env, profile)).toMatchObject({ download_dir: "/env/downloads", download_max_mb: 50 })
    expect(parseSettings(["--download-dir=~"], env, profile).download_dir).toBe(env.HOME)
    expect(parseSettings([], { ...env, DEMO_DOWNLOAD_DIR: "~/received" }, profile).download_dir).toBe(
      "/people/example/received",
    )
    expect(
      settingsFromOptions(
        { download_dir: "/options", download_max_mb: 2000 },
        {
          DEMO_DOWNLOAD_DIR: "relative",
          DEMO_DOWNLOAD_MAX_MB: "bad",
        },
        profile,
      ),
    ).toMatchObject({ download_dir: "/options", download_max_mb: 2000 })
  })

  test("relative paths and invalid option types name their source", () => {
    expect(failure(() => parseSettings(["--download-dir=relative"], {}, profile)).message).toContain("--download-dir")
    expect(failure(() => parseSettings([], { DEMO_DOWNLOAD_DIR: "relative" }, profile)).message).toContain(
      "DEMO_DOWNLOAD_DIR",
    )
    for (const value of ["relative", false, 1, null]) {
      expect(failure(() => settingsFromOptions({ download_dir: value }, {}, profile)).message).toContain(
        'Option "download_dir" must be an absolute path.',
      )
    }
  })

  test.each(["1", "2000", "1e2", " 50 "])("accepts the limit %s", (value) => {
    expect(parseSettings(["--download-max-mb", value], {}, profile).download_max_mb).toBe(Number(value))
    expect(parseSettings([], { DEMO_DOWNLOAD_MAX_MB: value }, profile).download_max_mb).toBe(Number(value))
  })

  test.each(["0", "2001", "1.5", "-5"])("refuses the limit %s outside 1 to 2000 or not whole", (value) => {
    expect(failure(() => parseSettings(["--download-max-mb", value], {}, profile)).message).toBe(
      "--download-max-mb must be a whole number from 1 to 2000.",
    )
    expect(failure(() => parseSettings([], { DEMO_DOWNLOAD_MAX_MB: value }, profile)).message).toBe(
      "DEMO_DOWNLOAD_MAX_MB must be a whole number from 1 to 2000.",
    )
  })

  test.each(["text", "true", "false", "Infinity", "NaN"])("refuses the limit %s that is not a number", (value) => {
    expect(failure(() => parseSettings(["--download-max-mb", value], {}, profile)).message).toContain(
      "--download-max-mb",
    )
    expect(failure(() => parseSettings([], { DEMO_DOWNLOAD_MAX_MB: value }, profile)).message).toContain(
      "DEMO_DOWNLOAD_MAX_MB",
    )
  })

  test.each([0, 2001, 1.5])("refuses plugin limit %j outside 1 to 2000 or not whole", (value) => {
    expect(failure(() => settingsFromOptions({ download_max_mb: value }, {}, profile)).message).toBe(
      'Option "download_max_mb" must be a whole number from 1 to 2000.',
    )
  })

  test.each(["100", "text", true, false, null])("refuses plugin limit %j that is not a number", (value) => {
    expect(failure(() => settingsFromOptions({ download_max_mb: value }, {}, profile)).message).toBe(
      'Option "download_max_mb" must be a finite number.',
    )
  })
})
