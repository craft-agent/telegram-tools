import { Buffer } from "node:buffer"
import { isReservedDeviceName, plainPathProblem } from "../archive/entry-names"
import { hasMisleadingCharacters } from "../archive/name-characters"

/** The most bytes a file name may take: what every file system takes. */
const MAX_NAME_BYTES = 255

/** The longest extension kept apart when a name is shortened or numbered, dot included, in bytes. */
const MAX_EXTENSION_BYTES = 32

/** Characters that separate paths or that Windows does not allow in a name. */
const UNSAFE_CHARACTERS = /[/\\:<>"|?*]/

const TRAILING_DOTS_AND_SPACES = /[. ]+$/

/** File extensions by the content types of the files Telegram sends without a name. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
}

/** The kinds of media a nameless file is called after (`photo`, `voice`, …): short lower-case words, nothing a sender could shape into a path. */
const KIND_PATTERN = /^[a-z]{1,16}$/

/** The word a file is named after when its kind is none the pattern allows. */
const UNKNOWN_KIND = "file"

/** What names a file that has no usable name: its kind, the message it came with and its declared content type. */
export type FallbackName = { kind: string; id: number; type: string | null | undefined }

function byteLength(text: string): number {
  return Buffer.byteLength(text)
}

/** The extension a content type stands for, with its dot, or none. */
function extensionOf(type: string | null | undefined): string {
  return type == null ? "" : (EXTENSIONS[type.split(";")[0]!.trim().toLowerCase()] ?? "")
}

/** A name apart from its last extension (a dot and up to 32 bytes), which stays when the name is shortened. */
function splitExtension(name: string): [base: string, extension: string] {
  const dot = name.lastIndexOf(".")
  if (dot <= 0 || dot === name.length - 1) return [name, ""]
  const extension = name.slice(dot)
  return byteLength(extension) > MAX_EXTENSION_BYTES ? [name, ""] : [name.slice(0, dot), extension]
}

/** `base + suffix + extension` with the base cut, by whole characters, until it fits in 255 bytes. */
function fitted(base: string, suffix: string, extension: string): string {
  const room = MAX_NAME_BYTES - byteLength(suffix) - byteLength(extension)
  const characters = Array.from(base)
  while (characters.length > 0 && byteLength(characters.join("")) > room) characters.pop()
  return characters.join("").replace(TRAILING_DOTS_AND_SPACES, "") + suffix + extension
}

/** The name a file with none is saved under: `<kind>-<id>` and an extension for its declared type, never one from the sender. */
function fallbackName({ kind, id, type }: FallbackName): string {
  return `${KIND_PATTERN.test(kind) ? kind : UNKNOWN_KIND}-${id}${extensionOf(type)}`
}

/**
 * The name a file is saved under, from the name its sender gave it:
 * NFC, with path separators, `:` and `<>"|?*`, control characters and the
 * bidi controls shown as `_`, trailing dots and spaces dropped (Windows
 * drops them), a leading dot hidden behind `_`, a Windows device name such
 * as `CON.txt` prefixed with `_`, and at most 255 bytes of UTF-8 with the
 * extension kept. A file with no usable name is `<kind>-<id>` (the media
 * kind and the message's id) with an extension for its declared content type,
 * when one is known. The result always passes the rules for a plain path
 * component that `inspectArchive` holds archive entries to.
 */
export function safeFileName(raw: string | null | undefined, fallback: FallbackName): string {
  if (raw == null) return fallbackName(fallback)
  let name = Array.from(raw.normalize("NFC"), (character) =>
    UNSAFE_CHARACTERS.test(character) || hasMisleadingCharacters(character) ? "_" : character,
  )
    .join("")
    .trim()
    .replace(TRAILING_DOTS_AND_SPACES, "")
  if (name === "") return fallbackName(fallback)
  if (name.startsWith(".") || isReservedDeviceName(name)) name = `_${name}`
  const [base, extension] = splitExtension(name)
  name = byteLength(name) > MAX_NAME_BYTES ? fitted(base, "", extension) : name
  return plainPathProblem(name, false) === undefined ? name : fallbackName(fallback)
}

/** `name` numbered for a second file of the same name: `photo (2).jpg`, still within 255 bytes. */
export function numberedName(name: string, number: number): string {
  const [base, extension] = splitExtension(name)
  return fitted(base, ` (${number})`, extension)
}

/** The name of the folder an archive is unpacked into, `<name>.unpacked`, or `<name> (2).unpacked` for the second, within 255 bytes. */
export function unpackedName(name: string, number = 1): string {
  return fitted(name, `${number === 1 ? "" : ` (${number})`}.unpacked`, "")
}
