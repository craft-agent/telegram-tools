import { Buffer } from "node:buffer"
import type { Readable } from "node:stream"
import { Long, type tl } from "@mtcute/core"
import type { FakeMethod } from "./sync-client.testing"
import { onAbort } from "./sync-wait"

/** The type the fake works out for an upload unless a test says otherwise. */
const DEFAULT_MIME = "application/octet-stream"

/** An upload as the fake received it: what it was told, and the bytes it read from the stream. */
export type FakeUpload = {
  /** The id of the `inputFile` it answers with. */
  id: Long
  fileName?: string
  fileSize?: number
  abortSignal?: AbortSignal
  /** The bytes read from the stream; empty until the fake has read it all. */
  bytes: Uint8Array
}

/**
 * How an upload ends: with a type, with an error it throws, never (until it
 * is aborted, when the abort reason is thrown), or after `stallAfter` bytes of
 * progress, which is then all it ever reports.
 */
export type FakeUploadAnswer = { mime: string } | Error | "hang" | { stallAfter: number }

/** How `uploadFile` ends: one way for every upload, or one worked out from the upload. */
export type FakeUploadScript = FakeUploadAnswer | ((upload: FakeUpload) => FakeUploadAnswer | Promise<FakeUploadAnswer>)

/** What the fake adds for uploading: `uploadFile`, scripted and recorded. */
export type FakeUploadMethods = {
  /** Sets how every later `uploadFile` ends; it succeeds with a generic type by default. */
  setUploadAnswer(script: FakeUploadScript): void
  /** Every upload made, in order. */
  uploads: FakeUpload[]
  uploadFile(params: {
    file: unknown
    fileName?: string
    fileSize?: number
    abortSignal?: AbortSignal
    progressCallback?: (uploaded: number, total: number) => void
  }): Promise<{ inputFile: tl.TypeInputFile; size: number; mime: string }>
}

async function bytesOf(stream: Readable): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) chunks.push(chunk as Uint8Array)
  return Buffer.concat(chunks)
}

/** Waits until `signal` aborts, and then throws what it aborted with. */
export function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => onAbort(signal, () => reject(signal?.reason)))
}

/** The upload method of the fake client; `record` is the fake's own, which notes a call and throws a scripted failure. */
export function fakeUploadMethods(record: (method: FakeMethod, arg?: unknown) => void): FakeUploadMethods {
  let script: FakeUploadScript = { mime: DEFAULT_MIME }
  const uploads: FakeUpload[] = []
  return {
    uploads,
    setUploadAnswer: (next) => void (script = next),
    async uploadFile({ file, fileName, fileSize, abortSignal, progressCallback }) {
      const upload: FakeUpload = {
        id: Long.fromNumber(7_000 + uploads.length),
        fileName,
        fileSize,
        abortSignal,
        bytes: new Uint8Array(),
      }
      record("uploadFile", upload)
      uploads.push(upload)
      upload.bytes = await bytesOf(file as Readable)
      const answer = typeof script === "function" ? await script(upload) : script
      if (answer instanceof Error) throw answer
      if (answer === "hang") await untilAborted(abortSignal)
      if (typeof answer === "object" && "stallAfter" in answer) {
        progressCallback?.(answer.stallAfter, upload.bytes.length)
        await untilAborted(abortSignal)
      }
      const mime = typeof answer === "object" && "mime" in answer ? answer.mime : DEFAULT_MIME
      progressCallback?.(upload.bytes.length, upload.bytes.length)
      const inputFile: tl.RawInputFile = {
        _: "inputFile",
        id: upload.id,
        parts: 1,
        name: fileName ?? "",
        md5Checksum: "",
      }
      return { inputFile, size: upload.bytes.length, mime }
    },
  }
}
