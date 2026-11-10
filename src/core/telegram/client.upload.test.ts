import { Readable } from "node:stream"
import { describe, expect, test } from "bun:test"
import { uploadFile } from "@mtcute/core/methods.js"
import { createPlatform } from "./client-parts"

type UploadingClient = Parameters<typeof uploadFile>[0]

/** The parts of mtcute's client that `uploadFile` touches, with the platform of ours; `call` records the parts. */
function uploadingClient(parts: Uint8Array[]) {
  const platform = createPlatform(() => {})
  return {
    platform,
    storage: { self: { getCached: () => undefined } },
    log: { debug: () => {} },
    getPoolSize: async () => 1,
    call: async (request: { bytes: Uint8Array }) => {
      parts.push(request.bytes)
      return true
    },
  } as unknown as UploadingClient
}

describe("the platform's file normalizing", () => {
  test("lets mtcute upload a Node stream whole, with the size and the name the caller gave", async () => {
    const parts: Uint8Array[] = []
    const bytes = Buffer.from("made-up bytes for an upload".repeat(10))

    const uploaded = await uploadFile(uploadingClient(parts), {
      file: Readable.from([bytes.subarray(0, 100), bytes.subarray(100)]),
      fileName: "notes.txt",
      fileSize: bytes.length,
    })

    expect(Buffer.concat(parts).toString()).toBe(bytes.toString())
    expect(uploaded.size).toBe(bytes.length)
    expect(uploaded.mime).toBe("text/plain")
    expect(uploaded.inputFile).toMatchObject({ _: "inputFile", name: "notes.txt", parts: 1 })
  })

  test("takes a Node stream and nothing else: a path is not opened for mtcute", () => {
    const { normalizeFile } = createPlatform(() => {})

    expect(normalizeFile?.("/etc/hosts")).toBeNull()
    expect(normalizeFile?.(new Uint8Array(1))).toBeNull()
  })
})
