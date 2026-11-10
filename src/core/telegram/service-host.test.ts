import { describe, expect, test } from "bun:test"
import { ToolError } from "../errors"
import {
  defaultServiceHost,
  installService,
  removeServiceLog,
  serviceStatus,
  uninstallService,
  type ServiceHost,
  type ServiceSpec,
} from "./service-host"
import { mapProgramError } from "./service-types"

describe("service dispatcher", () => {
  const spec: ServiceSpec = {
    id: "com.example.tool",
    launcher: "example-sync",
    label: "default",
    description: "Example sync service",
    program: "/bin/node",
    args: [],
    path: "/bin",
  }

  test("refuses unsupported platforms with invalid_argument", async () => {
    const host: ServiceHost = {
      platform: "win32",
      home: "C:\\Users\\test",
      uid: 0,
      env: {},
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
    }

    const installError = await installService(spec, host).catch((e: unknown) => e)
    expect(installError).toBeInstanceOf(ToolError)
    expect((installError as ToolError).code).toBe("invalid_argument")
    expect((installError as ToolError).message).toBe("Running the sync service is supported on macOS and Linux only.")

    const uninstallError = await uninstallService(spec, spec.label, host).catch((e: unknown) => e)
    expect((uninstallError as ToolError).code).toBe("invalid_argument")

    const statusError = await serviceStatus(spec.id, spec.label, host).catch((e: unknown) => e)
    expect((statusError as ToolError).code).toBe("invalid_argument")
  })

  test("removeServiceLog does nothing on Linux and unsupported platforms", async () => {
    for (const platform of ["linux", "win32"] as const) {
      const ran: string[][] = []
      const host: ServiceHost = {
        platform,
        home: "/nonexistent/home",
        uid: 0,
        env: {},
        run: async (argv) => (ran.push(argv), { code: 0, stdout: "", stderr: "" }),
      }

      await removeServiceLog(spec.id, spec.label, host)
      expect(ran).toEqual([])
    }
  })

  test("mapProgramError masks phone numbers and truncates to 300 characters", () => {
    const error1 = mapProgramError("systemctl", {
      code: 1,
      stdout: "",
      stderr: "Error connecting to +15551234567 daemon",
    })
    expect(error1.code).toBe("upstream_error")
    expect(error1.message).toBe("systemctl failed: Error connecting to [number] daemon")

    const error2 = mapProgramError("launchctl", { code: 1, stdout: "", stderr: "x".repeat(350) })
    expect(error2.message).toBe(`launchctl failed: ${"x".repeat(300)}`)

    const emptyError = mapProgramError("launchctl", { code: 1, stdout: "", stderr: "" })
    expect(emptyError.message).toBe("launchctl failed.")
  })

  test("defaultServiceHost provides required host properties", () => {
    const host = defaultServiceHost()
    expect(host.platform).toBe(process.platform)
    expect(typeof host.home).toBe("string")
    expect(typeof host.uid).toBe("number")
    expect(typeof host.run).toBe("function")
  })
})
