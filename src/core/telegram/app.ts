import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { ToolError } from "../errors"

/** The Telegram app a label logs in with: the `api_id` and `api_hash` from my.telegram.org. */
export type AppCredentials = { apiId: number; apiHash: string }

/** The permissions of the credentials file: readable and writable by the owner only. */
const APP_FILE_MODE = 0o600

/** The length of an `api_hash`, in hexadecimal characters. */
const API_HASH_LENGTH = 32

const API_ID_PATTERN = /^[1-9][0-9]*$/
const API_HASH_PATTERN = new RegExp(`^[0-9a-f]{${API_HASH_LENGTH}}$`)

const INVALID_API_ID = "The api_id must be a positive whole number."
const INVALID_API_HASH = `The api_hash must be ${API_HASH_LENGTH} hexadecimal characters.`
const UNREADABLE_APP = "The app credentials of this account cannot be read; log in again."

function checkApiId(apiId: number): number {
  if (!Number.isSafeInteger(apiId) || apiId <= 0) throw new ToolError("invalid_argument", INVALID_API_ID)
  return apiId
}

/** Reads an `api_id` typed or set in the environment (surrounding spaces allowed); throws `invalid_argument` without echoing it. */
export function parseApiId(text: string): number {
  const trimmed = text.trim()
  if (!API_ID_PATTERN.test(trimmed)) throw new ToolError("invalid_argument", INVALID_API_ID)
  return checkApiId(Number(trimmed))
}

/** Reads an `api_hash` typed or set in the environment, trimmed and lowercased; throws `invalid_argument` without echoing it. */
export function parseApiHash(text: string): string {
  const hash = text.trim().toLowerCase()
  if (!API_HASH_PATTERN.test(hash)) throw new ToolError("invalid_argument", INVALID_API_HASH)
  return hash
}

/**
 * Reads a label's `app.json`. A missing file is `not_found`; one that cannot be read or does not hold
 * a valid `api_id` and `api_hash` is `upstream_error`. No message carries the path or the content.
 */
export function readApp(path: string): AppCredentials {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ToolError("not_found", "This account has no app credentials yet; log in first.")
    }
    throw new ToolError("upstream_error", UNREADABLE_APP)
  }
  try {
    const parsed = JSON.parse(text) as { api_id?: unknown; api_hash?: unknown }
    if (typeof parsed.api_id !== "number" || typeof parsed.api_hash !== "string") throw new Error("malformed")
    return { apiId: checkApiId(parsed.api_id), apiHash: parseApiHash(parsed.api_hash) }
  } catch {
    throw new ToolError("upstream_error", UNREADABLE_APP)
  }
}

/**
 * Saves a label's app credentials as `{ "api_id": n, "api_hash": "..." }`, mode 0600, through a temp
 * file in the same directory that is renamed into place. Invalid values are `invalid_argument`.
 */
export function writeApp(path: string, app: AppCredentials): void {
  const content = `${JSON.stringify({ api_id: checkApiId(app.apiId), api_hash: parseApiHash(app.apiHash) })}\n`
  const temp = join(dirname(path), `.app.${process.pid}.tmp`)
  try {
    writeFileSync(temp, content, { mode: APP_FILE_MODE })
    chmodSync(temp, APP_FILE_MODE)
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}
