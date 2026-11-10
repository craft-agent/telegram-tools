import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  buildLaunchdPlist,
  installLaunchdService,
  LAUNCHER_SCRIPT,
  launchdServiceStatus,
  removeLaunchdServiceLog,
  uninstallLaunchdService,
  xmlEscape,
} from "./service-launchd"
import type { ServiceHost, ServiceName, ServiceSpec } from "./service-types"
import type { ExecResult } from "../exec"

const ID = "com.example.tool"
const LAUNCHER = "example-sync"
const NAME: ServiceName = { id: ID, launcher: LAUNCHER }
const NOT_FOUND: ExecResult = { code: 113, stdout: "", stderr: "Could not find service" }
const FOUND: ExecResult = { code: 0, stdout: "state = running\n", stderr: "" }
const LAUNCHER_PATH = "/Users/test/Library/Application Support/com.example.tool/example-sync-work"

const BASE_SPEC: ServiceSpec = {
  ...NAME,
  label: "work",
  description: "Example sync service",
  program: "/bin/node",
  args: ["sync"],
  path: "/bin",
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

function createFakeHost(
  home: string,
  overrides: Partial<ServiceHost> = {},
): {
  host: ServiceHost
  calls: string[][]
} {
  const calls: string[][] = []
  const customRun = overrides.run
  const host: ServiceHost = {
    platform: "darwin",
    home,
    uid: 501,
    env: { PATH: "/usr/bin:/bin" },
    sleep: async () => {},
    ...overrides,
    run: async (argv: string[]): Promise<ExecResult> => {
      calls.push(argv)
      if (customRun) return customRun(argv)
      if (argv[1] === "print") return NOT_FOUND
      return { code: 0, stdout: "", stderr: "" }
    },
  }
  return { host, calls }
}

describe("service-launchd", () => {
  test("xmlEscape escapes special characters", () => {
    expect(xmlEscape("a & b < c > d \"e\" 'f'")).toBe("a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;")
  })

  test("buildLaunchdPlist generates valid plist XML with required keys and escaped strings", () => {
    const spec: ServiceSpec = {
      ...BASE_SPEC,
      program: "/path/to/node",
      args: ["/path/to/cli.js", "sync", "--label", "work <test>", "--state-dir", "/state & dir"],
      path: "/usr/local/bin:/usr/bin",
    }
    const logPath = `/Users/test/Library/Logs/${ID}/work.log`
    const xml = buildLaunchdPlist(spec, logPath, LAUNCHER_PATH)

    expect(xml).toContain(`<key>Label</key>\n\t<string>${ID}.work</string>`)
    expect(xml).toContain(
      `<array>\n\t\t<string>${LAUNCHER_PATH}</string>\n\t\t<string>/path/to/node</string>\n\t\t<string>/path/to/cli.js</string>`,
    )
    expect(xml).toContain("<string>/path/to/node</string>")
    expect(xml).toContain("<string>work &lt;test&gt;</string>")
    expect(xml).toContain("<string>/state &amp; dir</string>")
    expect(xml).toContain("<key>PATH</key>\n\t\t<string>/usr/local/bin:/usr/bin</string>")
    expect(xml).toContain("<key>RunAtLoad</key>\n\t<true/>")
    expect(xml).toContain("<key>SuccessfulExit</key>\n\t\t<false/>")
    expect(xml).toContain("<key>ThrottleInterval</key>\n\t<integer>60</integer>")
    expect(xml).toContain("<key>ProcessType</key>\n\t<string>Background</string>")
    expect(xml).toContain(`<key>StandardOutPath</key>\n\t<string>${logPath}</string>`)
    expect(xml).toContain(`<key>StandardErrorPath</key>\n\t<string>${logPath}</string>`)
  })

  test("refuses control characters in program, args, PATH, or description", async () => {
    const logPath = "/tmp/test.log"

    expect(() => buildLaunchdPlist({ ...BASE_SPEC, program: "/bin/no\nde" }, logPath, LAUNCHER_PATH)).toThrow(
      "Control characters are not allowed in the program.",
    )
    expect(() => buildLaunchdPlist({ ...BASE_SPEC, args: ["sync", "arg\x00bad"] }, logPath, LAUNCHER_PATH)).toThrow(
      "Control characters are not allowed in an argument.",
    )
    expect(() => buildLaunchdPlist({ ...BASE_SPEC, path: "/bin:\r/usr/bin" }, logPath, LAUNCHER_PATH)).toThrow(
      "Control characters are not allowed in PATH.",
    )
    expect(() => buildLaunchdPlist({ ...BASE_SPEC, description: "bad\ntext" }, logPath, LAUNCHER_PATH)).toThrow(
      "Control characters are not allowed in the description.",
    )

    const dir = await mkdtemp(join(tmpdir(), "tg-"))
    try {
      const { host } = createFakeHost(dir)
      const error = await installLaunchdService({ ...BASE_SPEC, program: "/bin/no\x7fde" }, host).catch(
        (e: unknown) => e,
      )
      expect((error as { code: string }).code).toBe("invalid_argument")
      expect((error as Error).message).toContain("the program")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("installLaunchdService creates directories with proper modes, writes plist 0644, and runs launchctl", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tg-"))
    try {
      const { host, calls } = createFakeHost(dir)
      const spec: ServiceSpec = { ...BASE_SPEC, label: "default", args: ["cli.js", "sync"] }

      const result = await installLaunchdService(spec, host)

      const expectedPlist = join(dir, `Library/LaunchAgents/${ID}.default.plist`)
      const expectedLogDir = join(dir, `Library/Logs/${ID}`)
      expect(result.file).toBe(expectedPlist)
      expect(result.log).toBe(join(expectedLogDir, "default.log"))

      const plistStat = await stat(expectedPlist)
      expect(plistStat.mode & 0o777).toBe(0o644)

      const logDirStat = await stat(expectedLogDir)
      expect(logDirStat.mode & 0o777).toBe(0o700)

      expect(calls).toEqual([
        ["launchctl", "bootout", `gui/501/${ID}.default`],
        ["launchctl", "print", `gui/501/${ID}.default`],
        ["launchctl", "bootstrap", "gui/501", expectedPlist],
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("installLaunchdService ignores 'not loaded' during bootout but maps bootstrap failure to upstream_error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tg-"))
    try {
      const { host } = createFakeHost(dir, {
        run: async (argv: string[]) => {
          if (argv[1] === "bootout") {
            return { code: 3, stdout: "", stderr: "Boot-out failed: 3: No such process" }
          }
          if (argv[1] === "bootstrap") {
            return { code: 1, stdout: "", stderr: "Bootstrap failed for +1234567890 permission denied" }
          }
          if (argv[1] === "print") return NOT_FOUND
          return { code: 0, stdout: "", stderr: "" }
        },
      })

      const error = await installLaunchdService({ ...BASE_SPEC, label: "default", args: [] }, host).catch(
        (e: unknown) => e,
      )
      expect((error as { code: string }).code).toBe("upstream_error")
      expect((error as Error).message).toBe("launchctl failed: Bootstrap failed for [number] permission denied")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("uninstallLaunchdService unloads and deletes plist; not installed is fine", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tg-"))
    try {
      const { host, calls } = createFakeHost(dir, {
        run: async (argv: string[]) => {
          if (argv[1] === "bootout") {
            return { code: 1, stdout: "", stderr: "service is not loaded" }
          }
          if (argv[1] === "print") return NOT_FOUND
          return { code: 0, stdout: "", stderr: "" }
        },
      })

      await uninstallLaunchdService(NAME, "default", host)
      expect(calls[0]).toEqual(["launchctl", "bootout", `gui/501/${ID}.default`])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("uninstallLaunchdService removes an installed plist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tg-"))
    try {
      const { host } = createFakeHost(dir)
      const { file } = await installLaunchdService({ ...BASE_SPEC, label: "default" }, host)

      await uninstallLaunchdService(NAME, "default", host)

      const gone = await stat(file).then(
        () => false,
        () => true,
      )
      expect(gone).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("removeLaunchdServiceLog deletes the log and its empty directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tg-"))
    try {
      const { host } = createFakeHost(dir)
      const { log } = await installLaunchdService({ ...BASE_SPEC, label: "default" }, host)
      await writeFile(log, "line\n")

      await removeLaunchdServiceLog(ID, "default", host)

      expect(await exists(log)).toBe(false)
      expect(await exists(dirname(log))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("removeLaunchdServiceLog leaves another label's log and the directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tg-"))
    try {
      const { host } = createFakeHost(dir)
      const first = await installLaunchdService({ ...BASE_SPEC, label: "default" }, host)
      const second = await installLaunchdService({ ...BASE_SPEC, label: "work" }, host)
      await writeFile(first.log!, "one\n")
      await writeFile(second.log!, "two\n")

      await removeLaunchdServiceLog(ID, "default", host)

      expect(await exists(first.log!)).toBe(false)
      expect(await readFile(second.log!, "utf8")).toBe("two\n")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("removeLaunchdServiceLog does not throw when nothing exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tg-"))
    try {
      const { host } = createFakeHost(dir)
      await removeLaunchdServiceLog(ID, "default", host)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("uninstallLaunchdService keeps the log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tg-"))
    try {
      const { host } = createFakeHost(dir)
      const { log } = await installLaunchdService({ ...BASE_SPEC, label: "default" }, host)
      await writeFile(log, "line\n")

      await uninstallLaunchdService(NAME, "default", host)

      expect(await readFile(log, "utf8")).toBe("line\n")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("installLaunchdService writes the launcher first in the plist, 0755 in a 0700 directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tg-"))
    try {
      const { host } = createFakeHost(dir)
      const { file } = await installLaunchdService({ ...BASE_SPEC, label: "default", args: ["cli.js", "sync"] }, host)

      const launcherDir = join(dir, "Library", "Application Support", ID)
      const launcher = join(launcherDir, `${LAUNCHER}-default`)
      expect(await readFile(launcher, "utf8")).toBe(LAUNCHER_SCRIPT)
      expect((await stat(launcher)).mode & 0o777).toBe(0o755)
      expect((await stat(launcherDir)).mode & 0o777).toBe(0o700)

      const plist = await readFile(file, "utf8")
      expect(plist).toContain(
        `<array>\n\t\t<string>${launcher}</string>\n\t\t<string>/bin/node</string>\n\t\t<string>cli.js</string>`,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("installLaunchdService replaces the launcher on reinstall and leaves no staging file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tg-"))
    try {
      const { host } = createFakeHost(dir)
      const launcherDir = join(dir, "Library", "Application Support", ID)
      const launcher = join(launcherDir, `${LAUNCHER}-work`)
      await installLaunchdService(BASE_SPEC, host)
      await writeFile(launcher, "old\n")
      await writeFile(join(launcherDir, `.${LAUNCHER}-work.tmp`), "stale\n")

      await installLaunchdService(BASE_SPEC, host)

      expect(await readFile(launcher, "utf8")).toBe(LAUNCHER_SCRIPT)
      expect(await readdir(launcherDir)).toEqual([`${LAUNCHER}-work`])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("installLaunchdService replaces a link at the launcher path without following it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tg-"))
    try {
      const { host } = createFakeHost(dir)
      const launcherDir = join(dir, "Library", "Application Support", ID)
      const launcher = join(launcherDir, `${LAUNCHER}-work`)
      const target = join(dir, "target")
      await writeFile(target, "keep\n")
      await mkdir(launcherDir, { recursive: true })
      await symlink(target, launcher)

      await installLaunchdService(BASE_SPEC, host)

      expect(await readFile(target, "utf8")).toBe("keep\n")
      expect((await lstat(launcher)).isFile()).toBe(true)
      expect(await readFile(launcher, "utf8")).toBe(LAUNCHER_SCRIPT)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses an invalid launcher name, writing nothing on install", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tg-"))
    try {
      const { host, calls } = createFakeHost(dir)
      for (const launcher of ["", "../x", "a/b", ".hidden", "a b"]) {
        const error = await installLaunchdService({ ...BASE_SPEC, launcher }, host).catch((e: unknown) => e)
        expect((error as { code: string }).code).toBe("invalid_argument")
        expect((error as Error).message).toContain("launcher name")
      }
      expect(calls).toEqual([])
      expect(await readdir(dir)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("uninstallLaunchdService refuses an invalid launcher name only after bootout and plist deletion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tg-"))
    try {
      const { host, calls } = createFakeHost(dir)
      const { file } = await installLaunchdService(BASE_SPEC, host)
      calls.length = 0

      const error = await uninstallLaunchdService({ id: ID, launcher: "../x" }, "work", host).catch((e: unknown) => e)

      expect((error as { code: string }).code).toBe("invalid_argument")
      expect(calls).toEqual([
        ["launchctl", "bootout", `gui/501/${ID}.work`],
        ["launchctl", "print", `gui/501/${ID}.work`],
      ])
      expect(await exists(file)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("uninstallLaunchdService deletes the launcher and its empty directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tg-"))
    try {
      const { host } = createFakeHost(dir)
      await installLaunchdService(BASE_SPEC, host)
      const launcherDir = join(dir, "Library", "Application Support", ID)

      await uninstallLaunchdService(NAME, "work", host)

      expect(await exists(join(launcherDir, `${LAUNCHER}-work`))).toBe(false)
      expect(await exists(launcherDir)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("uninstallLaunchdService leaves another label's launcher and the directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tg-"))
    try {
      const { host } = createFakeHost(dir)
      await installLaunchdService({ ...BASE_SPEC, label: "default" }, host)
      await installLaunchdService({ ...BASE_SPEC, label: "work" }, host)
      const launcherDir = join(dir, "Library", "Application Support", ID)

      await uninstallLaunchdService(NAME, "default", host)

      expect(await exists(join(launcherDir, `${LAUNCHER}-default`))).toBe(false)
      expect(await readFile(join(launcherDir, `${LAUNCHER}-work`), "utf8")).toBe(LAUNCHER_SCRIPT)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("uninstallLaunchdService leaves a link at the launcher path in place", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tg-"))
    try {
      const { host } = createFakeHost(dir)
      const launcherDir = join(dir, "Library", "Application Support", ID)
      const launcher = join(launcherDir, `${LAUNCHER}-work`)
      const target = join(dir, "target")
      await writeFile(target, "keep\n")
      await mkdir(launcherDir, { recursive: true })
      await symlink(target, launcher)

      await uninstallLaunchdService(NAME, "work", host)

      expect((await lstat(launcher)).isSymbolicLink()).toBe(true)
      expect(await readFile(target, "utf8")).toBe("keep\n")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  describe("waiting for launchd to let go of the job", () => {
    const plistRelative = `Library/LaunchAgents/${ID}.${BASE_SPEC.label}.plist`
    const launcherRelative = `Library/Application Support/${ID}/${LAUNCHER}-${BASE_SPEC.label}`
    const maxPolls = 150

    /** A host whose `print` finds the job for the first `found` polls, or always when `found` is Infinity. */
    function lingeringHost(dir: string, found: number, onPrint: () => void = () => {}) {
      const sleeps: number[] = []
      let prints = 0
      const fake = createFakeHost(dir, {
        sleep: async (ms) => {
          sleeps.push(ms)
        },
        run: async (argv) => {
          if (argv[1] !== "print") return { code: 0, stdout: "", stderr: "" }
          prints++
          onPrint()
          return prints <= found ? FOUND : NOT_FOUND
        },
      })
      return { ...fake, sleeps, prints: () => prints }
    }

    test("install bootstraps only once the job is gone", async () => {
      const dir = await mkdtemp(join(tmpdir(), "tg-"))
      try {
        const { host, calls, sleeps } = lingeringHost(dir, 2)

        await installLaunchdService(BASE_SPEC, host)

        expect(calls.map((argv) => argv[1])).toEqual(["bootout", "print", "print", "print", "bootstrap"])
        expect(sleeps).toEqual([200, 200])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    test("install gives up when the job never goes", async () => {
      const dir = await mkdtemp(join(tmpdir(), "tg-"))
      try {
        const { host, calls, prints } = lingeringHost(dir, Infinity)

        const error = await installLaunchdService(BASE_SPEC, host).catch((e: unknown) => e)

        expect((error as { code: string }).code).toBe("upstream_error")
        expect((error as Error).message).toContain("30 seconds")
        expect(calls.some((argv) => argv[1] === "bootstrap")).toBe(false)
        expect(prints()).toBe(maxPolls)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    test("uninstall deletes the plist only once the job is gone", async () => {
      const dir = await mkdtemp(join(tmpdir(), "tg-"))
      try {
        await installLaunchdService(BASE_SPEC, createFakeHost(dir).host)
        const plist = join(dir, plistRelative)
        const plistPresentAtPrint: boolean[] = []
        const { host } = lingeringHost(dir, 2, () => {
          plistPresentAtPrint.push(existsSync(plist))
        })

        await uninstallLaunchdService(NAME, BASE_SPEC.label, host)

        expect(plistPresentAtPrint).toEqual([true, true, true])
        expect(existsSync(plist)).toBe(false)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    test("uninstall that times out leaves the plist and launcher in place", async () => {
      const dir = await mkdtemp(join(tmpdir(), "tg-"))
      try {
        await installLaunchdService(BASE_SPEC, createFakeHost(dir).host)
        const { host } = lingeringHost(dir, Infinity)

        const error = await uninstallLaunchdService(NAME, BASE_SPEC.label, host).catch((e: unknown) => e)

        expect((error as { code: string }).code).toBe("upstream_error")
        expect(existsSync(join(dir, plistRelative))).toBe(true)
        expect(existsSync(join(dir, launcherRelative))).toBe(true)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  })

  test("launchdServiceStatus parses state, pid, and last exit code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tg-"))
    try {
      const spec: ServiceSpec = { ...BASE_SPEC, label: "default", args: [] }

      const { host: host1 } = createFakeHost(dir)
      const notInstalled = await launchdServiceStatus(spec.id, spec.label, host1)
      expect(notInstalled.installed).toBe(false)
      expect(notInstalled.running).toBe(false)

      await installLaunchdService(spec, host1)

      const { host: hostRunning } = createFakeHost(dir, {
        run: async (argv: string[]) => {
          if (argv[1] === "print") {
            return { code: 0, stdout: "state = running\npid = 4321\nlast exit code = 0\n", stderr: "" }
          }
          return { code: 0, stdout: "", stderr: "" }
        },
      })
      const runningStatus = await launchdServiceStatus(spec.id, spec.label, hostRunning)
      expect(runningStatus.installed).toBe(true)
      expect(runningStatus.running).toBe(true)
      expect(runningStatus.pid).toBe(4321)
      expect(runningStatus.lastExit).toBe(0)

      const { host: hostStopped } = createFakeHost(dir, {
        run: async (argv: string[]) => {
          if (argv[1] === "print") {
            return { code: 0, stdout: "state = waiting\nlast exit code = 1\n", stderr: "" }
          }
          return { code: 0, stdout: "", stderr: "" }
        },
      })
      const stoppedStatus = await launchdServiceStatus(spec.id, spec.label, hostStopped)
      expect(stoppedStatus.installed).toBe(true)
      expect(stoppedStatus.running).toBe(false)
      expect(stoppedStatus.pid).toBeUndefined()
      expect(stoppedStatus.lastExit).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
