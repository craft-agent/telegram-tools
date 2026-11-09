import { inspectArchive, type ArchiveListing } from "../archive/inspect"
import { classifyFile, type ArchiveFormat } from "../archive/kind"
import type { ArchiveLimits } from "../archive/limits"
import { ArchiveRefused } from "../archive/refused"
import { openDownloaded } from "./incoming"
import { copyToPartial, discard, type Copied } from "./place"

/** What became of the downloaded file when it was judged. */
export type CheckOutcome =
  | { kind: "refused"; reason: string }
  | {
      kind: "checked"
      /** The private copy that passed, still to be placed. */
      copied: Copied
      /** Set when the file is an archive that passed inspection. */
      archive?: { format: ArchiveFormat; listing: ArchiveListing }
    }

/**
 * Judges the file the service downloaded: copies it into a private partial
 * beside it, taking its SHA-256, judges the copy by its name, declared type and
 * first bytes (a program or an installer is removed again), and inspects it
 * when it is an archive (a refused one is removed again). A file that passes is
 * left as a partial for `placeFile`. The partial is gone whatever else happens.
 */
export async function checkDownloaded(
  incoming: string,
  path: string,
  name: string,
  type: string | undefined,
  signal?: AbortSignal,
  limits?: ArchiveLimits,
): Promise<CheckOutcome> {
  const source = await openDownloaded(incoming, path)
  const copied = await copyToPartial(source.handle, source.folder, signal).finally(() => source.handle.close())
  try {
    const kind = classifyFile({ name, type, head: copied.head })
    if (kind.kind === "refused") {
      await discard(copied.partial)
      return { kind: "refused", reason: kind.reason }
    }
    let archive: Extract<CheckOutcome, { kind: "checked" }>["archive"]
    if (kind.kind === "archive") {
      try {
        archive = { format: kind.format, listing: await inspectArchive(copied.partial, kind.format, limits, signal) }
      } catch (error) {
        if (!(error instanceof ArchiveRefused)) throw error
        await discard(copied.partial)
        return { kind: "refused", reason: error.message }
      }
    }
    return { kind: "checked", copied, ...(archive && { archive }) }
  } catch (error) {
    await discard(copied.partial)
    throw error
  }
}
