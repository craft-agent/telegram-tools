import { expect } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"
import { isToolError, type GrantContext } from "../core"
import { PROFILE_OPTIONS } from "./options.testing"
import type { EntryProfile } from "./profile"

/** Fixtures the settings tests share. */

export const profile: EntryProfile = {
  name: "demo-tools",
  envPrefix: "DEMO",
  toolsets: { names: ["alpha", "beta", "gamma"], defaults: ["alpha"] },
  options: PROFILE_OPTIONS,
}

/** The file settings' defaults: download_dir, download_max_mb and send_dirs. */
export const FILE_SETTINGS = { download_dir: expect.any(String), download_max_mb: 100, send_dirs: [] }

/** The grants' context of settings that name no grant setting, read from an environment without `HOME` or `XDG_STATE_HOME`. */
export const DEFAULT_GRANTS: GrantContext = {
  unattended: false,
  dir: join(homedir(), ".local", "state", profile.name, "grants"),
  key: undefined,
}

export function failure(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    return error as Error
  }
  throw new Error("expected the settings to be rejected")
}
