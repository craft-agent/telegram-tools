import { Buffer } from "node:buffer"
import { open } from "node:fs/promises"
import type { Message } from "@mtcute/core"
import { CLASSIFY_HEAD_BYTES, classifyFile } from "../archive/kind"
import { labelPaths } from "./labels"
import type { Mirror } from "./mirror"
import { isCount, type MessageInput } from "./mirror-input"
import { BYTES_PER_MB, type DeclaredFile } from "./service-requests"
import { disappearsAtOf, messageFile, type MessageFile } from "./sync-download-file"
import { declaredRefusal, isDeclaredArchive } from "./sync-download-refusal"
import { writeDownload, type DownloadStreamContext } from "./sync-download-stream"
import { commitKept, createKeptStaging, discardKeptStaging, pruneKept, type KeptMeta } from "./sync-kept-store"
import type { ResolvedSyncOptions } from "./sync-options"
import type { RequestQueue } from "./sync-request-queue"

/** The most a kept file may be: 100 MB, declared and received. */
export const KEPT_MAX_BYTES = 100 * BYTES_PER_MB

/** What keeping a file works with: the download's context, the mirror, and the queue the downloads share. */
export type KeepContext = DownloadStreamContext & {
  mirror: Mirror
  settings: Pick<ResolvedSyncOptions, "stateDir" | "label" | "log" | "transferStallMs">
  /** The queue of `download` requests: keeping a file waits its turn in it. */
  queue: RequestQueue
}

/** Why a file is not kept, as the log tells it; fixed texts, never a name or an id. */
const NOT_KEPT = {
  refused: "a disappearing file was not kept: its name or type is refused",
  archive: "a disappearing file was not kept: it is an archive",
  declaredSize: "a disappearing file was not kept: it is over the size limit",
  receivedSize: "a disappearing file was not kept: it passed the size limit",
  bytes: "a disappearing file was not kept: its bytes are not a plain file",
  failed: "a disappearing file could not be kept",
  partial: "a partial copy could not be removed",
  tidy: "kept files could not be cleaned up",
} as const

/** Whether a message disappears by its chat's timer, can be opened once, or destroys itself after being opened. */
function disappears({ ttl, viewOnce, selfDestruct }: MessageInput): boolean {
  return (isCount(ttl) && ttl > 0) || viewOnce || (isCount(selfDestruct) && selfDestruct > 0)
}

/** Why a file is not kept for what its sender declares of it, or undefined when it may be. */
function declaredReason(declared: DeclaredFile): string | undefined {
  if (declaredRefusal(declared) !== undefined) return NOT_KEPT.refused
  if (isDeclaredArchive(declared)) return NOT_KEPT.archive
  if (declared.size !== null && declared.size > KEPT_MAX_BYTES) return NOT_KEPT.declaredSize
  return undefined
}

/** The first bytes of a file, as many as `classifyFile` needs. */
async function readHead(file: string): Promise<Uint8Array> {
  const handle = await open(file, "r")
  try {
    const buffer = Buffer.alloc(CLASSIFY_HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * Keeps the files of disappearing, view-once and self-destructing messages as
 * they arrive, in the label's `kept/`, while `keep_disappearing` is on: the
 * `download` request serves these copies once Telegram has removed the message.
 * Keeping runs in the background and never holds up storing a message: it
 * waits its turn in the downloads' queue, downloads into a staging folder,
 * checks the bytes, and renames the folder into place only when complete. A
 * failure logs a fixed line and drops the copy; it never stops the service.
 */
export class FileKeeper {
  private readonly ctx: KeepContext
  private readonly kept: string
  private ready = false
  private readonly pending = new Set<Promise<void>>()

  constructor(ctx: KeepContext) {
    this.ctx = ctx
    this.kept = labelPaths(ctx.settings.stateDir, ctx.settings.label).kept
  }

  /** Starts keeping: call it once `kept/` has been swept, since the sweep removes staging folders. */
  begin(): void {
    this.ready = true
  }

  /** Resolves once everything started so far has settled; never rejects. */
  async idle(): Promise<void> {
    await Promise.all(this.pending)
  }

  /**
   * Keeps the file of `message`, which was just stored as `input`, when it
   * disappears and carries a file that may be kept; says why in the log when
   * it does not.
   */
  keep(message: Message, input: MessageInput): void {
    if (!this.ready || !disappears(input)) return
    const file = messageFile(message)
    if (!file) return
    const reason = declaredReason(file.declared)
    if (reason !== undefined) {
      this.ctx.settings.log(reason)
      return
    }
    const { queue, signal } = this.ctx
    const disappearsAt = disappearsAtOf(message)
    this.background(NOT_KEPT.failed, () =>
      queue.run(signal, () => this.keepFile(input.chat, input.id, file, disappearsAt)),
    )
  }

  /** Removes the kept folders of messages of `chat` (every chat when null) that the mirror no longer has. */
  forgetMessages(chat: string | null, ids: readonly number[]): void {
    this.background(NOT_KEPT.tidy, () => pruneKept(this.kept, this.ctx.mirror, { chat, ids }))
  }

  /** Removes the kept folders of chats whose messages the mirror no longer has. */
  forgetChats(chats: readonly string[]): void {
    this.background(NOT_KEPT.tidy, async () => {
      for (const chat of chats) await pruneKept(this.kept, this.ctx.mirror, { chat })
    })
  }

  /** Runs `work` beside the caller: a failure logs `failure` and nothing else, unless the service is closing, which is no failure. */
  private background(failure: string, work: () => Promise<void>): void {
    const task = work()
      .catch(() => {
        if (!this.ctx.signal.aborted) this.ctx.settings.log(failure)
      })
      .finally(() => this.pending.delete(task))
    this.pending.add(task)
  }

  /** Downloads a file into a staging folder and keeps it; whatever stops it leaves nothing behind. */
  private async keepFile(
    chat: string,
    id: number,
    { media, declared }: MessageFile,
    disappearsAt: number | undefined,
  ): Promise<void> {
    const { signal, mirror, settings } = this.ctx
    const { log } = settings
    const staging = await createKeptStaging(this.kept, chat, id)
    let committed = false
    try {
      const size = await writeDownload(this.ctx, signal, media, staging.file, KEPT_MAX_BYTES)
      if (size === undefined) {
        log(NOT_KEPT.receivedSize)
        return
      }
      const head = await readHead(staging.file)
      const verdict = classifyFile({ name: declared.name ?? undefined, type: declared.type ?? undefined, head })
      if (verdict.kind !== "file") {
        log(NOT_KEPT.bytes)
        return
      }
      const meta: KeptMeta = {
        name: declared.name,
        type: declared.type,
        kind: declared.kind,
        size,
        ...(disappearsAt === undefined ? {} : { disappears_at: disappearsAt }),
      }
      await commitKept(staging, meta)
      committed = true
    } finally {
      if (!committed) await discardKeptStaging(staging).catch(() => log(NOT_KEPT.partial))
    }
    // A delete for everyone that arrived while the file downloaded found no folder to remove.
    await pruneKept(this.kept, mirror, { chat, ids: [id] })
  }
}
