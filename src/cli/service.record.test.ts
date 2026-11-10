import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { labelPaths, type LabelPaths } from "../core/telegram/labels"
import { readServiceRecord } from "../core/telegram/service-record"
import { PROJECT } from "../project"
import { EXIT_OK, type CommandIo } from "./command-io"
import { fakeHost, harness, type Harness } from "./commands.testing"
import { runServiceCommand, SERVICE_ID } from "./service"

const VERSION = "9.8.7"

let open: Harness[] = []
let tools: string

beforeEach(async () => {
  tools = await mkdtemp(join(tmpdir(), "tg-tools-"))
})

afterEach(async () => {
  for (const t of open) t.close()
  open = []
  await rm(tools, { recursive: true, force: true })
})

function setUp(overrides: Partial<CommandIo> = {}): Harness {
  const t = harness(overrides)
  open.push(t)
  t.addLabel("default", true)
  return t
}

function pathsOf(t: Harness): LabelPaths {
  return labelPaths(t.stateDir, "default")
}

function run(t: Harness, action: string): Promise<number> {
  return runServiceCommand([action, "--state-dir", t.stateDir], t.io)
}

async function makeFile(path: string, body = "", mode = 0o644): Promise<string> {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, body)
  await chmod(path, mode)
  return path
}

async function versionedProgram(): Promise<string> {
  const program = join(tools, "rt", VERSION, "bin", "node")
  return makeFile(program, `#!/bin/sh\necho ${program}\n`, 0o755)
}

async function plistText(t: Harness): Promise<string> {
  return readFile(join(t.stateDir, "Library", "LaunchAgents", `${SERVICE_ID}.default.plist`), "utf8")
}

describe("CLI service record", () => {
  test("install writes the record with the program and script, mode 600", async () => {
    const t = setUp()
    const script = await makeFile(join(tools, "cli.js"))
    t.io.self = { program: "/bin/node", script }

    expect(await run(t, "install")).toBe(EXIT_OK)

    expect(t.err()).toBe("")
    const paths = pathsOf(t)
    expect(readServiceRecord(paths)).toEqual({ program: "/bin/node", script })
    expect((await stat(paths.serviceRecord)).mode & 0o777).toBe(0o600)
  })

  test("install warns when the program path holds its version and no stable node exists", async () => {
    const program = await versionedProgram()
    const script = await makeFile(join(tools, "cli.js"))
    const t = setUp({ env: { PATH: "" }, self: { program, script, version: VERSION } })

    expect(await run(t, "install")).toBe(EXIT_OK)

    expect(t.out()).toContain(
      "Install the service again after updating Node or this package, as it records both paths.",
    )
    expect(t.err()).toContain(`Warning: the service runs Node at a path that holds its version (${program});`)
    expect(readServiceRecord(pathsOf(t))?.program).toBe(program)
    expect(await plistText(t)).toContain(`<string>${program}</string>`)
  })

  test("install records a node at a path without the version when it starts the same program", async () => {
    const program = await versionedProgram()
    const script = await makeFile(join(tools, "cli.js"))
    const binDir = join(tools, "stable")
    await mkdir(binDir)
    const link = join(binDir, "node")
    await symlink(program, link)
    const t = setUp({ env: { PATH: binDir }, self: { program, script, version: VERSION } })

    expect(await run(t, "install")).toBe(EXIT_OK)

    expect(t.err()).toBe("")
    expect(readServiceRecord(pathsOf(t))?.program).toBe(link)
    expect(await plistText(t)).toContain(`<string>${link}</string>`)
  })

  test("install passes over a node under the temporary or runtime directory", async () => {
    const program = await versionedProgram()
    const script = await makeFile(join(tools, "cli.js"))
    const runtime = join(tools, "runtime")
    const binDir = join(runtime, "session", "bin")
    await mkdir(binDir, { recursive: true })
    await symlink(program, join(binDir, "node"))

    const envs: Record<string, string>[] = [{ XDG_RUNTIME_DIR: runtime }, { TMPDIR: runtime }]
    for (const env of envs) {
      const t = setUp({ env: { PATH: binDir, ...env }, self: { program, script, version: VERSION } })

      expect(await run(t, "install")).toBe(EXIT_OK)

      expect(t.err()).toContain("Warning: the service runs Node at a path that holds its version")
      expect(readServiceRecord(pathsOf(t))?.program).toBe(program)
    }
  })

  test("an install that fails leaves no record of the earlier program", async () => {
    const script = await makeFile(join(tools, "cli.js"))
    const t = setUp({ self: { program: "/bin/node", script } })
    await run(t, "install")
    const paths = pathsOf(t)
    expect(readServiceRecord(paths)).not.toBeNull()

    t.io.serviceHost = fakeHost(t.stateDir, { run: async () => ({ code: 1, stdout: "", stderr: "boom" }) })

    expect(await run(t, "install")).not.toBe(EXIT_OK)
    expect(readServiceRecord(paths)).toBeNull()
  })

  test("install does not warn when the program path does not hold the version", async () => {
    const script = await makeFile(join(tools, "cli.js"))
    const t = setUp({ self: { program: "/bin/node", script, version: VERSION } })

    await run(t, "install")

    expect(t.err()).toBe("")
  })

  test("uninstall deletes the record", async () => {
    const script = await makeFile(join(tools, "cli.js"))
    const t = setUp({ self: { program: "/bin/node", script } })
    await run(t, "install")
    const paths = pathsOf(t)
    expect(readServiceRecord(paths)).not.toBeNull()

    expect(await run(t, "uninstall")).toBe(EXIT_OK)

    expect(await stat(paths.serviceRecord).catch(() => undefined)).toBeUndefined()
  })

  test("uninstall succeeds without a record", async () => {
    const t = setUp()

    expect(await run(t, "uninstall")).toBe(EXIT_OK)

    expect(t.out()).toBe('Uninstalled sync service for "default".\n')
  })

  describe("status", () => {
    async function installed(): Promise<{ t: Harness; program: string; script: string }> {
      const t = setUp()
      const program = await makeFile(join(tools, "bin", "node"), "", 0o755)
      const script = await makeFile(join(tools, "cli.js"))
      t.io.self = { program, script }
      await run(t, "install")
      return { t, program, script }
    }

    test("shows the program and script when both exist", async () => {
      const { t, program, script } = await installed()

      expect(await run(t, "status")).toBe(EXIT_OK)

      expect(t.out()).toContain(`  Program: ${program}\n`)
      expect(t.out()).toContain(`  Script: ${script}\n`)
      expect(t.out()).not.toContain("Missing:")
      expect(t.out()).not.toContain("gone")
    })

    test("names a missing program with the fix", async () => {
      const { t, program, script } = await installed()
      await rm(program)

      await run(t, "status")

      expect(t.out()).toContain(`  Missing: ${program}\n`)
      expect(t.out()).not.toContain(`  Missing: ${script}\n`)
      expect(t.out()).toContain(
        `The program it was installed with is gone, as after updating Node or this package; install it again with: ${PROJECT.cli} service install --account default\n`,
      )
    })

    test("names a missing program and script", async () => {
      const { t, program, script } = await installed()
      await rm(program)
      await rm(script)

      await run(t, "status")

      expect(t.out()).toContain(`  Missing: ${program}\n`)
      expect(t.out()).toContain(`  Missing: ${script}\n`)
      expect(t.out()).toContain(
        "The program and script it was installed with are gone, as after updating Node or this package;",
      )
    })

    test("prints none of these lines without a record", async () => {
      const t = setUp()

      expect(await run(t, "status")).toBe(EXIT_OK)

      for (const line of ["Program:", "Script:", "Missing:", "gone"]) expect(t.out()).not.toContain(line)
    })
  })
})
