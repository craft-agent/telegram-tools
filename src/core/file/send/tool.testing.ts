import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { ServiceCalls } from "../../chat/read.testing"
import type { ToolError } from "../../errors"
import { createSendFixture, type SendFixture } from "../../message/send.testing"
import { labelPaths, type LabelPaths } from "../../telegram/labels"
import { USER } from "../../telegram/mirror.testing"
import type { SendFilesParams, SendFilesResult } from "../../telegram/service-requests"
import { invoke, type ToolContext } from "../../tool"
import { DOWNLOAD_CONTEXT } from "../../tool.testing"
import type { FileSendOutput } from "./schema"
import { telegramFileSend } from "./tool"

/** The time a test's accepted file send is dated. */
export const FILES_SENT_AT = 1_800_000_000_000

/** A file of a send as the fake service saw it while the call was open. */
export type SeenCopy = { path: string; name: string; content: Buffer; mode: number; folderMode: number }

/** What the fake service answers to a send: the file messages 101, 102, … in order, dated `FILES_SENT_AT`. */
export function acceptedFiles(params: unknown): SendFilesResult {
  const { files } = params as SendFilesParams
  return { messages: files.map(({ name }, position) => ({ id: 101 + position, name })), date: FILES_SENT_AT }
}

/** A sync fixture with a working directory to send files from, and the way to call `telegram_file_send` in it. */
export type FileSendFixture = Omit<SendFixture, "close"> & {
  /** The working directory the calls run in (a real path). */
  work: string
  paths: LabelPaths
  /** Writes a file below the working directory and returns its path. */
  write(path: string, content?: string | Uint8Array): string
  /** Calls the tool for `USER`'s chat, each argument overridden by `args`; `ctx` replaces parts of the context, `tool` the tool. */
  sendFiles(
    args: Record<string, unknown>,
    ctx?: Partial<ToolContext>,
    tool?: typeof telegramFileSend,
  ): Promise<FileSendOutput>
  /** The error a call throws. */
  filesFailure(
    args: Record<string, unknown>,
    ctx?: Partial<ToolContext>,
    tool?: typeof telegramFileSend,
  ): Promise<ToolError>
  /** The context a call runs in. */
  context(extra?: Partial<ToolContext>): ToolContext
  /** The names in the label's outbox: the folders of calls that are still there. */
  outboxEntries(): string[]
  /**
   * Serves `send_files`, answering with `answer` (`acceptedFiles` by default)
   * and noting the copies it is given as they are while the call is open.
   * Resolves with the requests it receives and the copies it saw.
   */
  serveFiles(answer?: (params: unknown) => unknown): Promise<{ calls: ServiceCalls; seen: SeenCopy[] }>
  close(): Promise<void>
}

/** A state directory with one logged-in label `default`, an empty mirror and a working directory to send files from. */
export function createFileSendFixture(): FileSendFixture {
  const base = createSendFixture()
  const work = realpathSync(mkdtempSync(join(tmpdir(), "send-work-")))
  const paths = labelPaths(base.stateDir, "default")
  const context = (extra: Partial<ToolContext> = {}): ToolContext => ({
    cwd: work,
    stateDir: base.stateDir,
    ...DOWNLOAD_CONTEXT,
    ...extra,
  })
  const withDefaults = (args: Record<string, unknown>) => ({ chat: USER, ...args })
  const run = (args: Record<string, unknown>, ctx: Partial<ToolContext> = {}, tool = telegramFileSend) =>
    invoke(tool, withDefaults(args), context(ctx))
  return {
    ...base,
    work,
    paths,
    context,
    write(path, content = "made-up content\n") {
      const full = join(work, path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content)
      return full
    },
    sendFiles: run,
    async filesFailure(args, ctx, tool) {
      try {
        await run(args, ctx, tool)
      } catch (error) {
        if (error instanceof Error) return error as ToolError
        throw error
      }
      throw new Error("Expected the call to fail")
    },
    outboxEntries: () => (existsSync(paths.outbox) ? readdirSync(paths.outbox) : []),
    async serveFiles(answer = acceptedFiles) {
      const seen: SeenCopy[] = []
      const calls = await base.serve({
        send_files: (params) => {
          for (const { path, name } of (params as SendFilesParams).files) {
            seen.push({
              path,
              name,
              content: readFileSync(path),
              mode: statSync(path).mode & 0o777,
              folderMode: statSync(dirname(path)).mode & 0o777,
            })
          }
          return answer(params)
        },
      })
      return { calls, seen }
    },
    async close() {
      await base.stopServices()
      base.close()
      rmSync(work, { recursive: true, force: true })
    },
  }
}
