import { expect } from "bun:test"
import { isToolError } from "../core"
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

export function failure(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    return error as Error
  }
  throw new Error("expected the settings to be rejected")
}
