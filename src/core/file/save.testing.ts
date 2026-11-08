import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createChatFixture, type ChatFixture, type ServiceCalls } from "../chat/read.testing"
import { ToolError } from "../errors"
import type { ExecResult } from "../exec"
import { labelPaths, type LabelPaths } from "../telegram/labels"
import type { DownloadResult } from "../telegram/service-requests"
import { USER } from "../telegram/mirror.testing"
import { invoke, type ToolContext } from "../tool"
import { DOWNLOAD_CONTEXT } from "../tool.testing"
import { DIRECTORY_MODE, FILE_MODE } from "./constants"
import { createFileSave, type FileSaveHost } from "./save"
import type { FileSaveOutput } from "./schema"

/** A made-up message id, in the chat `USER`. */
export const MESSAGE_ID = 42

/** What a test says of the file the service downloads; the rest is a plain text document. */
export type Downloaded = {
  name?: string | null
  type?: string | null
  kind?: string
  disappears_at?: number
}

/** A linked label with a mirror that lists `USER`'s chat, a download directory, a scripted service and the tool. */
export type SaveFixture = {
  chat: ChatFixture
  stateDir: string
  downloadDir: string
  paths: LabelPaths
  /** The folder of the message `MESSAGE_ID`. */
  folder: string
  /** The programs the fake runner was asked to run, in order. */
  runs: string[][]
  /** Writes `content` into a new folder of the label's `incoming/` and returns the service's answer for it. */
  incoming(content: Uint8Array | string, declared?: Downloaded): DownloadResult
  /**
   * Serves `download` with a new file holding `content` each time. The label's
   * socket is served once per fixture; a later call changes the answer. Resolves
   * with the requests received.
   */
  serveFile(content: Uint8Array | string, declared?: Downloaded): Promise<ServiceCalls>
  /** Serves `download` with the answer `answer` makes, as `serveFile` does. */
  serve(answer: () => DownloadResult | Promise<DownloadResult>): Promise<ServiceCalls>
  /** The names in the label's `incoming/`. */
  incomingNames(): string[]
  /** Calls the tool; `host` replaces parts of the machine, `ctx` parts of the context. */
  save(
    args: Record<string, unknown>,
    options?: { host?: Partial<FileSaveHost>; ctx?: Partial<ToolContext> },
  ): Promise<FileSaveOutput>
  /** The error a call throws. */
  failure(args: Record<string, unknown>, options?: { ctx?: Partial<ToolContext> }): Promise<ToolError>
  close(): Promise<void>
}

/** The arguments that save the message `MESSAGE_ID` of `USER`'s chat. */
export function saveArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { chat: USER, id: MESSAGE_ID, ...extra }
}

export function createSaveFixture(): SaveFixture {
  const chat = createChatFixture()
  chat.known()
  const { stateDir } = chat
  const downloadDir = realpathSync(mkdtempSync(join(tmpdir(), "dl-")))
  const paths = labelPaths(stateDir, "default")
  const runs: string[][] = []
  const ok: ExecResult = { code: 0, stdout: "", stderr: "" }
  let downloads = 0
  const context = (extra: Partial<ToolContext> = {}): ToolContext => ({
    cwd: stateDir,
    stateDir,
    ...DOWNLOAD_CONTEXT,
    downloadDir,
    programName: "telegram-tools",
    ...extra,
  })
  const tool = (host: Partial<FileSaveHost> = {}) =>
    createFileSave({
      platform: "linux",
      run: async (argv) => {
        runs.push(argv)
        return ok
      },
      now: () => 1_700_000_123_000,
      uuid: () => "11111111-2222-4333-8444-555555555555",
      ...host,
    })
  const incoming = (content: Uint8Array | string, declared: Downloaded = {}): DownloadResult => {
    mkdirSync(paths.incoming, { recursive: true, mode: DIRECTORY_MODE })
    const dir = join(paths.incoming, `download-${++downloads}`)
    mkdirSync(dir, { mode: DIRECTORY_MODE })
    const path = join(dir, "file")
    writeFileSync(path, content, { mode: FILE_MODE })
    const size = typeof content === "string" ? Buffer.byteLength(content) : content.length
    return { saved: { name: "notes.txt", type: "text/plain", kind: "document", ...declared, path, size } }
  }
  let answer: (() => DownloadResult | Promise<DownloadResult>) | undefined
  let calls: ServiceCalls | undefined
  const serve = async (next: () => DownloadResult | Promise<DownloadResult>): Promise<ServiceCalls> => {
    answer = next
    calls ??= await chat.serve({ download: () => answer!() })
    return calls
  }
  return {
    chat,
    stateDir,
    downloadDir,
    paths,
    folder: join(downloadDir, "default", USER, String(MESSAGE_ID)),
    runs,
    incoming,
    serveFile: (content, declared) => serve(() => incoming(content, declared)),
    serve,
    incomingNames: () => (existsSync(paths.incoming) ? readdirSync(paths.incoming) : []),
    save: (args, options = {}) => invoke(tool(options.host), args, context(options.ctx)),
    async failure(args, options = {}) {
      try {
        await invoke(tool(), args, context(options.ctx))
      } catch (error) {
        if (error instanceof ToolError) return error
        throw error
      }
      throw new Error("Expected the call to fail")
    },
    async close() {
      await chat.stopServices()
      chat.close()
      rmSync(downloadDir, { recursive: true, force: true })
    },
  }
}
