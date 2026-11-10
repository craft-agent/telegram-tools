import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isToolError } from "../errors"
import { DEFAULT_LABEL, checkLabel, ensureLabelDir, isLabel, labelPaths, listLabels, pickLabel } from "./labels"

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "tg-"))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe("isLabel and checkLabel", () => {
  const valid = [DEFAULT_LABEL, "a", "work_2", "a" + "0".repeat(22) + "b"]
  const invalid = [
    "",
    "a".repeat(25),
    "Work",
    "A",
    "DEFAULT",
    "_work",
    "work_",
    "work-1",
    "work.1",
    "work..1",
    "work/1",
    "work 1",
  ]

  test("accepts valid labels", () => {
    for (const label of valid) {
      expect(isLabel(label)).toBe(true)
      expect(checkLabel(label)).toBe(label)
    }
  })

  test("refuses invalid labels with invalid_argument ToolError", () => {
    for (const label of invalid) {
      expect(isLabel(label)).toBe(false)
      let error: unknown
      try {
        checkLabel(label)
      } catch (err) {
        error = err
      }
      expect(isToolError(error) && error.code).toBe("invalid_argument")
    }
  })

  test("quotes and truncates bad label preview in error message", () => {
    const longBad = "A".repeat(50)
    let error: unknown
    try {
      checkLabel(longBad)
    } catch (err) {
      error = err
    }
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    expect((error as Error).message).toContain(
      '"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA…" raw string check'.slice(0, 42),
    )
  })
})

describe("labelPaths", () => {
  test("returns correct directory and file layout", () => {
    const stateDir = join(tempDir, "state")
    const paths = labelPaths(stateDir, "work")

    expect(paths.label).toBe("work")
    expect(paths.dir).toBe(join(stateDir, "work"))
    expect(paths.session).toBe(join(stateDir, "work", "session.sqlite"))
    expect(paths.app).toBe(join(stateDir, "work", "app.json"))
    expect(paths.mirror).toBe(join(stateDir, "work", "mirror.sqlite"))
    expect(paths.socket).toBe(join(stateDir, "work", "sync.sock"))
    expect(paths.outbox).toBe(join(stateDir, "work", "outbox"))
    expect(paths.incoming).toBe(join(stateDir, "work", "incoming"))
    expect(paths.syncLock).toBe(join(stateDir, "work", "sync.lock"))
    expect(paths.serviceRecord).toBe(join(stateDir, "work", "service.json"))
  })

  test("throws internal_error on relative stateDir", () => {
    let error: unknown
    try {
      labelPaths("relative/state", "work")
    } catch (err) {
      error = err
    }
    expect(isToolError(error) && error.code).toBe("internal_error")
  })

  test("refuses socket path longer than 103 bytes", () => {
    // 1 + 85 + 1 + 1 + 1 + 9 = 97 chars <= 103 bytes
    const okState = "/" + "a".repeat(85)
    expect(() => labelPaths(okState, "a")).not.toThrow()

    // 1 + 92 + 1 + 1 + 1 + 9 = 104 chars > 103 bytes
    const longState = "/" + "a".repeat(92)
    let error: unknown
    try {
      labelPaths(longState, "a")
    } catch (err) {
      error = err
    }
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    expect((error as Error).message).toContain("shorter state directory")
  })
})

describe("listLabels", () => {
  test("returns empty array when stateDir does not exist", async () => {
    expect(await listLabels(join(tempDir, "missing"))).toEqual([])
  })

  test("returns sorted labels, skipping files, symlinks and invalid names", async () => {
    const state = join(tempDir, "state")
    mkdirSync(state)

    mkdirSync(join(state, "zebra"))
    mkdirSync(join(state, "apple"))
    mkdirSync(join(state, "middle"))

    // Regular file
    writeFileSync(join(state, "file_label"), "data")

    // Symlinked directory
    const targetDir = join(tempDir, "target")
    mkdirSync(targetDir)
    symlinkSync(targetDir, join(state, "symlink_dir"))

    // Invalid label names
    mkdirSync(join(state, "UPPERCASE"))
    mkdirSync(join(state, "with-hyphen"))
    mkdirSync(join(state, "_leading"))

    const labels = await listLabels(state)
    expect(labels).toEqual(["apple", "middle", "zebra"])
  })
})

describe("pickLabel", () => {
  test("with given account that exists returns its paths", async () => {
    const state = join(tempDir, "state")
    mkdirSync(join(state, "work"), { recursive: true })

    const paths = await pickLabel(state, "work")
    expect(paths.label).toBe("work")
  })

  test("with given account that is missing and no accounts logged in throws not_found", async () => {
    const state = join(tempDir, "state")
    mkdirSync(state)

    let error: unknown
    try {
      await pickLabel(state, "work")
    } catch (err) {
      error = err
    }
    expect(isToolError(error) && error.code).toBe("not_found")
    expect((error as Error).message).toContain("no Telegram account is logged in yet")
  })

  test("with given account that is missing and other accounts exist throws not_found naming known", async () => {
    const state = join(tempDir, "state")
    mkdirSync(join(state, "personal"), { recursive: true })

    let error: unknown
    try {
      await pickLabel(state, "work")
    } catch (err) {
      error = err
    }
    expect(isToolError(error) && error.code).toBe("not_found")
    expect((error as Error).message).toContain("known accounts: personal")
  })

  test("with given account that has invalid name throws invalid_argument", async () => {
    const state = join(tempDir, "state")
    mkdirSync(state)

    let error: unknown
    try {
      await pickLabel(state, "INVALID")
    } catch (err) {
      error = err
    }
    expect(isToolError(error) && error.code).toBe("invalid_argument")
  })

  test("with absent account and exactly one label returns it", async () => {
    const state = join(tempDir, "state")
    mkdirSync(join(state, "solo"), { recursive: true })

    const paths = await pickLabel(state, undefined)
    expect(paths.label).toBe("solo")
  })

  test("with absent account and no labels throws not_found with login instruction", async () => {
    const state = join(tempDir, "state")
    mkdirSync(state)

    let error: unknown
    try {
      await pickLabel(state, undefined)
    } catch (err) {
      error = err
    }
    expect(isToolError(error) && error.code).toBe("not_found")
    expect((error as Error).message).toBe("No Telegram account is logged in yet; log in first.")
  })

  test("with absent account and several labels throws invalid_argument listing them", async () => {
    const state = join(tempDir, "state")
    mkdirSync(join(state, "alpha"), { recursive: true })
    mkdirSync(join(state, "beta"), { recursive: true })

    let error: unknown
    try {
      await pickLabel(state, undefined)
    } catch (err) {
      error = err
    }
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    expect((error as Error).message).toBe(
      "Several Telegram accounts are logged in; name one with `account`: alpha, beta.",
    )
  })
})

describe("ensureLabelDir", () => {
  test("creates stateDir and labelDir with mode 0700", async () => {
    const state = join(tempDir, "sub", "state")
    const paths = await ensureLabelDir(state, "work")

    const stateStat = statSync(state)
    const labelStat = statSync(paths.dir)

    expect(stateStat.mode & 0o777).toBe(0o700)
    expect(labelStat.mode & 0o777).toBe(0o700)
  })

  test("fixes existing 0755 directories to 0700", async () => {
    const state = join(tempDir, "state")
    const labelDir = join(state, "work")
    mkdirSync(labelDir, { recursive: true, mode: 0o755 })
    chmodSync(state, 0o755)
    chmodSync(labelDir, 0o755)

    expect(statSync(state).mode & 0o777).toBe(0o755)
    expect(statSync(labelDir).mode & 0o777).toBe(0o755)

    await ensureLabelDir(state, "work")

    expect(statSync(state).mode & 0o777).toBe(0o700)
    expect(statSync(labelDir).mode & 0o777).toBe(0o700)
  })

  test("refuses symlink as label directory", async () => {
    const state = join(tempDir, "state")
    mkdirSync(state)
    const realDir = join(tempDir, "real")
    mkdirSync(realDir)
    symlinkSync(realDir, join(state, "link_label"))

    let error: unknown
    try {
      await ensureLabelDir(state, "link_label")
    } catch (err) {
      error = err
    }
    expect(isToolError(error) && error.code).toBe("invalid_argument")
  })
})
