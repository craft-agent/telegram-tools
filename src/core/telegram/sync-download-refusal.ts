import { extensionOf } from "../archive/kind"
import { REFUSED_EXTENSIONS, REFUSED_MIME_PATTERNS, REFUSED_MIME_TYPES } from "../archive/kind-lists"
import { BYTES_PER_MB, type DeclaredFile } from "./service-requests"

const MIME_PARAMETERS = /;.*$/

/**
 * Why a file is refused by what its sender declares of it, before any byte is
 * downloaded: a name or a type that says program, installer, an archive
 * format that cannot be inspected, or an animated sticker. Only the name's
 * and the type's rules of `classifyFile` apply: whether the bytes are an
 * archive or a mislabeled one is judged on the downloaded copy.
 */
export function declaredRefusal({ name, type }: Pick<DeclaredFile, "name" | "type">): string | undefined {
  const mimeType = (type ?? "").replace(MIME_PARAMETERS, "").trim().toLowerCase()
  return (
    REFUSED_EXTENSIONS.get(extensionOf(name ?? "")) ??
    REFUSED_MIME_TYPES.get(mimeType) ??
    REFUSED_MIME_PATTERNS.find(([pattern]) => pattern.test(mimeType))?.[1]
  )
}

/** Bytes as whole megabytes, rounded up. */
function megabytes(bytes: number): number {
  return Math.ceil(bytes / BYTES_PER_MB)
}

/** Why a file over the limit is refused; `size` is what it declares, or `null` when it declares none. */
export function tooLargeReason(size: number | null, maxBytes: number): string {
  const limit = `over the ${megabytes(maxBytes)} MB download limit`
  return size === null ? `it is ${limit}` : `it is ${megabytes(size)} MB, ${limit}`
}
