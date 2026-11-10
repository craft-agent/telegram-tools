import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TelegramClientSettings } from "../core/telegram/client"
import { labelPaths, type LabelPaths } from "../core/telegram/labels"
import { createFakeLoginClient, type FakeLoginClient } from "../core/telegram/login.testing"
import type { ServiceHost } from "../core/telegram/service-host"
import type { CommandClient, CommandIo } from "./command-io"

/** Fixtures the command tests share: no real Telegram, no real service manager, a temporary state directory. */

/** A made-up app, as `my.telegram.org` would give. */
export const APP = { apiId: 123456, apiHash: "0123456789abcdef0123456789abcdef" }

/** The profile-prefixed variables of the package's own profile. */
export const ENV_APP = { TELEGRAM_TOOLS_API_ID: String(APP.apiId), TELEGRAM_TOOLS_API_HASH: APP.apiHash }

/** The fake login client with what logging out and closing add. */
export type FakeCommandClient = FakeLoginClient & {
  destroyed: number
  loggedOut: number
  /** Makes `logOut` fail the way an unreachable Telegram does. */
  failLogOut: boolean
}

export function createFakeCommandClient(): FakeCommandClient {
  const client = Object.assign(createFakeLoginClient(), {
    destroyed: 0,
    loggedOut: 0,
    failLogOut: false,
    async destroy() {
      client.destroyed += 1
    },
    async logOut() {
      if (client.failLogOut) throw new Error("network down")
      client.loggedOut += 1
    },
  })
  return client
}

/** A service host that records the commands it is asked to run and succeeds. */
export function fakeHost(home: string, overrides: Partial<ServiceHost> = {}): ServiceHost & { ran: string[][] } {
  const ran: string[][] = []
  return {
    platform: "darwin",
    home,
    uid: 501,
    env: { PATH: "/bin" },
    sleep: async () => {},
    run: async (argv) => {
      ran.push(argv)
      if (argv[1] === "print") return { code: 113, stdout: "", stderr: "Could not find service" }
      return { code: 0, stdout: "", stderr: "" }
    },
    ...overrides,
    ran,
  }
}

/** One command run's surroundings. */
export type Harness = {
  stateDir: string
  io: CommandIo
  /** Everything the command wrote to standard output, and to standard error. */
  out(): string
  err(): string
  /** The client the command built last, and the settings it was built with. */
  client: FakeCommandClient
  built: TelegramClientSettings[]
  host: ReturnType<typeof fakeHost>
  /** Creates a label directory, with a session file when `loggedIn`. */
  addLabel(label: string, loggedIn?: boolean): LabelPaths
  close(): void
}

/** A harness over a fresh state directory; `overrides` replace parts of the command's io. */
export function harness(overrides: Partial<CommandIo> = {}): Harness {
  const stateDir = mkdtempSync(join(tmpdir(), "tg-cmd-"))
  let stdout = ""
  let stderr = ""
  const built: TelegramClientSettings[] = []
  const host = fakeHost(stateDir)
  const t: Harness = {
    stateDir,
    out: () => stdout,
    err: () => stderr,
    client: createFakeCommandClient(),
    built,
    host,
    addLabel(label, loggedIn = false) {
      const paths = labelPaths(stateDir, label)
      mkdirSync(paths.dir, { recursive: true })
      if (loggedIn) writeFileSync(paths.session, "")
      return paths
    },
    close: () => rmSync(stateDir, { recursive: true, force: true }),
    io: {
      env: {},
      isTTY: true,
      stdout: (text) => (stdout += text),
      stderr: (text) => (stderr += text),
      serviceHost: host,
      createClient(settings) {
        built.push(settings)
        return t.client as unknown as CommandClient
      },
      ...overrides,
    },
  }
  return t
}
