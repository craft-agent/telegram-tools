import { createInterface } from "node:readline/promises"
import { Writable } from "node:stream"
import type { TelegramClientSettings } from "../core/telegram/client"
import type { LoginClient } from "../core/telegram/login"
import type { LogoutClient } from "../core/telegram/logout"
import type { ServiceHost } from "../core/telegram/service-host"
import type { runSync } from "../core/telegram/sync"
import type { SyncTelegram } from "../core/telegram/sync-telegram"
import type { EntryProfile } from "../entry/profile"

/** The exit codes of a command: it did its work, the work failed, or the command line was wrong. */
export const EXIT_OK = 0
export const EXIT_FAILED = 1
export const EXIT_USAGE = 2

/** Default interactive line reader on standard input. */
export async function defaultReadLine(prompt: string): Promise<string | undefined> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question(prompt)
  } finally {
    rl.close()
  }
}

/** Default hidden line reader: the prompt is written, and what the person types is not echoed. */
export async function defaultReadHidden(prompt: string): Promise<string | undefined> {
  let muted = false
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stdout.write(chunk)
      done()
    },
  })
  const rl = createInterface({ input: process.stdin, output, terminal: true })
  try {
    const answer = rl.question(prompt)
    muted = true
    return await answer
  } finally {
    rl.close()
    process.stdout.write("\n")
  }
}

/** What a command of the command line needs from its surroundings; `main.ts` wires the process, a test supplies its own. */
export type CommandIo = {
  /** Where the `<envPrefix>_*` settings fall back to. */
  env: Record<string, string | undefined>
  /** Receives what a command says to the person. */
  stdout(text: string): void
  /** Receives usage lines and errors. */
  stderr(text: string): void
  /** Stops a running command when it aborts. */
  signal?: AbortSignal
  /** The settings' environment prefix and the toolsets; defaults to this package's. */
  profile?: EntryProfile
  /** Whether standard input is an interactive terminal. */
  isTTY?: boolean
  /** Reads a line of input with an optional prompt; used for interactive confirmations. */
  readLine?(prompt: string): Promise<string | undefined>
  /** Reads a line of input without echoing it; defaults to a muted terminal read. */
  readHidden?(prompt: string): Promise<string | undefined>
  /** Reads standard input to its end; an empty string when there is none. */
  readStdin?(): Promise<string>
  /** The node binary and the CLI script to put in the service; default `process.execPath` and the realpath of `process.argv[1]`. */
  self?: { program: string; script: string }
  /** Injectable service host for managing system services; defaults to the operating system host. */
  serviceHost?: ServiceHost
  /** Builds the client of a label; replaced by a test, defaults to `createTelegramClient`. */
  createClient?: ClientFactory
  /** Runs the sync service; replaced by a test, defaults to `runSync`. */
  runSync?: typeof runSync
}

/** What the commands use of a client: logging in, running the service and logging out. */
export type CommandClient = LoginClient & SyncTelegram & LogoutClient

/** Builds the client for a label's session file with the app's credentials; it does not connect until it is used. */
export type ClientFactory = (settings: TelegramClientSettings) => CommandClient
