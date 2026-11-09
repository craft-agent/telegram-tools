import { extensionOf } from "../archive/kind"
import {
  GZIP_EXTENSIONS,
  GZIP_MIME_TYPES,
  REFUSED_EXTENSIONS,
  REFUSED_MIME_PATTERNS,
  REFUSED_MIME_TYPES,
  TAR_EXTENSIONS,
  TAR_MIME_TYPES,
  ZIP_EXTENSIONS,
  ZIP_MIME_TYPES,
} from "../archive/kind-lists"
import { BYTES_PER_MB, type DeclaredFile } from "./service-requests"

const MIME_PARAMETERS = /;.*$/

/** The extensions that say a file is an archive this package can read: zip, tar and gzip. */
const ARCHIVE_EXTENSIONS: readonly string[] = [...ZIP_EXTENSIONS, ...TAR_EXTENSIONS, ...GZIP_EXTENSIONS]

/** The MIME types that say a file is an archive this package can read. */
const ARCHIVE_MIME_TYPES: readonly string[] = [...ZIP_MIME_TYPES, ...TAR_MIME_TYPES, ...GZIP_MIME_TYPES]

/** A declared MIME type without its parameters, in lower case; empty when none is declared. */
function mimeTypeOf(type: string | null): string {
  return (type ?? "").replace(MIME_PARAMETERS, "").trim().toLowerCase()
}

/**
 * Why a file is refused by what its sender declares of it, before any byte is
 * downloaded: a name or a type that says program, installer, an archive
 * format that cannot be inspected, or an animated sticker. Only the name's
 * and the type's rules of `classifyFile` apply: whether the bytes are an
 * archive or a mislabeled one is judged on the downloaded copy.
 */
export function declaredRefusal({ name, type }: Pick<DeclaredFile, "name" | "type">): string | undefined {
  const mimeType = mimeTypeOf(type)
  return (
    REFUSED_EXTENSIONS.get(extensionOf(name ?? "")) ??
    REFUSED_MIME_TYPES.get(mimeType) ??
    REFUSED_MIME_PATTERNS.find(([pattern]) => pattern.test(mimeType))?.[1]
  )
}

/** Whether the declared name or type says the file is a zip, a tar or a gzip: an archive, which is never kept as it arrives. */
export function isDeclaredArchive({ name, type }: Pick<DeclaredFile, "name" | "type">): boolean {
  return ARCHIVE_EXTENSIONS.includes(extensionOf(name ?? "")) || ARCHIVE_MIME_TYPES.includes(mimeTypeOf(type))
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
