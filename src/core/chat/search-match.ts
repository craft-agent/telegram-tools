import { ToolError } from "../errors"
import { foldCase } from "../fold"
import { isRecord } from "../telegram/service-errors"
import { readJson, type StoredMessage } from "./message-rows"

/**
 * The words of a search query, folded (see `foldCase`) and without repeats.
 * A query with no word, or none at all, is `invalid_argument`.
 */
export function searchWords(query: string | undefined): string[] {
  if (query === undefined) {
    throw new ToolError("invalid_argument", "query is required for search: give the words to look for.")
  }
  const words = foldCase(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    throw new ToolError("invalid_argument", "query must not be blank: give the words to look for.")
  }
  return [...new Set(words)]
}

/** The name a message's file was sent with, folded; undefined when it has none. */
function foldedFileName(media: string): string | undefined {
  const info = readJson(media)
  return isRecord(info) && typeof info.name === "string" ? foldCase(info.name) : undefined
}

/**
 * Whether every word is in the message's text (which is also a file's caption)
 * or in the name of its file; the words may sit in either. Earlier versions,
 * quoted text, reactions and the names behind mentions are not searched. The
 * media is read only when the text leaves a word unmatched.
 */
export function matchesAllWords(row: StoredMessage, words: readonly string[]): boolean {
  const text = foldCase(row.body ?? "")
  const unmatched = words.filter((word) => !text.includes(word))
  if (unmatched.length === 0) return true
  const name = row.media === null ? undefined : foldedFileName(row.media)
  return name !== undefined && unmatched.every((word) => name.includes(word))
}
