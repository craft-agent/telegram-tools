import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { resolve } from "node:path"
import type { ToolOptions } from "../core"
import { resolveDirectorySettings } from "./directory"
import { profile } from "./settings.testing"

const resolveWith = (options: ToolOptions, env: Record<string, string | undefined>) =>
  resolveDirectorySettings(options, env, profile)

describe("resolveDirectorySettings", () => {
  describe("when given", () => {
    test("keeps each parsed value", () => {
      expect(
        resolveWith(
          { state_dir: "/var/state", download_dir: "/received", download_max_mb: 42, send_dirs: ["/a", "/b"] },
          { HOME: "/home/user" },
        ),
      ).toEqual({ state_dir: "/var/state", download_dir: "/received", download_max_mb: 42, send_dirs: ["/a", "/b"] })
    })

    test("ignores a value of another type", () => {
      expect(resolveWith({ state_dir: 1, download_dir: ["/x"], download_max_mb: "5", send_dirs: "/a" }, {})).toEqual(
        resolveWith({}, {}),
      )
    })
  })

  describe("state_dir when not given", () => {
    test("uses $XDG_STATE_HOME/<profile.name> when XDG_STATE_HOME is absolute", () => {
      const result = resolveWith({}, { XDG_STATE_HOME: "/xdg/state", HOME: "/home/user" })
      expect(result.state_dir).toBe(resolve("/xdg/state", "demo-tools"))
    })

    test("ignores relative XDG_STATE_HOME and falls back to <home>/.local/state/<profile.name>", () => {
      const result = resolveWith({}, { XDG_STATE_HOME: "relative/xdg", HOME: "/home/user" })
      expect(result.state_dir).toBe(resolve("/home/user", ".local", "state", "demo-tools"))
    })

    test("uses <home>/.local/state/<profile.name> when XDG_STATE_HOME is unset", () => {
      expect(resolveWith({}, { HOME: "/home/user" }).state_dir).toBe(
        resolve("/home/user", ".local", "state", "demo-tools"),
      )
    })

    test("falls back to homedir() when HOME is unset or relative", () => {
      const expected = resolve(homedir(), ".local", "state", "demo-tools")
      expect(resolveWith({}, {}).state_dir).toBe(expected)
      expect(resolveWith({}, { HOME: "relative/home" }).state_dir).toBe(expected)
    })
  })

  describe("the other settings when not given", () => {
    test("download to <home>/Downloads/<profile.name>, whatever XDG_STATE_HOME says, up to 100 MB", () => {
      const result = resolveWith({}, { HOME: "/home/user", XDG_STATE_HOME: "/xdg/state" })
      expect(result.download_dir).toBe("/home/user/Downloads/demo-tools")
      expect(result.download_max_mb).toBe(100)
      expect(resolveWith({}, {}).download_dir).toBe(resolve(homedir(), "Downloads", "demo-tools"))
    })

    test("send from no directory besides the working one", () => {
      expect(resolveWith({}, { HOME: "/home/user" }).send_dirs).toEqual([])
    })
  })
})
