import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildLaunchdPlist,
  installLaunchdService,
  launchdServiceStatus,
  uninstallLaunchdService,
  xmlEscape,
} from "./service-launchd"
import type { ServiceHost, ServiceSpec } from "./service-types"
import type { ExecResult } from "../exec"

const ID = "com.example.tool"

const BASE_SPEC: ServiceSpec = {
  id: ID,
  label: "work",
  description: "Example sync service",
  program: "/bin/node",
  args: ["sync"],
  path: "/bin",
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
    ...overrides,
    run: async (argv: string[]): Promise<ExecResult> => {
      calls.push(argv)
      if (customRun) return customRun(argv)
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
    const xml = buildLaunchdPlist(spec, logPath)

    expect(xml).toContain(`<key>Label</key>\n\t<string>${ID}.work</string>`)
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

    expect(() => buildLaunchdPlist({ ...BASE_SPEC, program: "/bin/no\nde" }, logPath)).toThrow(
      "Control characters are not allowed in the program.",
    )
    expect(() => buildLaunchdPlist({ ...BASE_SPEC, args: ["sync", "arg\x00bad"] }, logPath)).toThrow(
      "Control characters are not allowed in an argument.",
    )
    expect(() => buildLaunchdPlist({ ...BASE_SPEC, path: "/bin:\r/usr/bin" }, logPath)).toThrow(
      "Control characters are not allowed in PATH.",
    )
    expect(() => buildLaunchdPlist({ ...BASE_SPEC, description: "bad\ntext" }, logPath)).toThrow(
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
          return { code: 0, stdout: "", stderr: "" }
        },
      })

      await uninstallLaunchdService(ID, "default", host)
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

      await uninstallLaunchdService(ID, "default", host)

      const gone = await stat(file).then(
        () => false,
        () => true,
      )
      expect(gone).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
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
