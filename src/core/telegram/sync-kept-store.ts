import { Buffer } from "node:buffer"
import { randomBytes } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { lstat, open, readdir, rename, rm, rmdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Mirror } from "./mirror"
import { isCount } from "./mirror-input"
import type { SavedFile } from "./service-requests"
import { FILE_MODE, writeAll } from "./sync-download-stream"
import { DOWNLOADED_FILE_NAME, newPrivateFolder, privateFolder } from "./sync-incoming"

/** The facts kept with a kept file: what its message declared, the bytes kept, and when the message disappears. */
export type KeptMeta = Omit<SavedFile, "path" | "kept">

/** A kept message's file, found: where it is, what is known of it, and its size on disk. */
export type KeptCopy = { file: string; meta: KeptMeta; size: number }

/** A kept file being written in a folder of its own beside its final one; nothing is kept until `commitKept`. */
export type KeptStaging = { dir: string; file: string; target: string }

/** The name of a kept message's facts, beside its file. */
const META_FILE_NAME = "meta.json"

/** A chat's folder is named by its marked id. */
const CHAT_FOLDER = /^-?[0-9]+$/

/** A message's folder is named by its id. */
const MESSAGE_FOLDER = /^[1-9][0-9]*$/

/** How many random bytes name a staging folder. */
const STAGING_NAME_BYTES = 8

/** The most a `meta.json` may hold; what is larger is not ours. */
const MAX_META_BYTES = 64 * 1024

/** How much of a kept file is read and written at a time. */
const COPY_CHUNK_BYTES = 64 * 1024

/** Makes an open fail on a link in the last component instead of following it. */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0

/** What the log says when a link or a file stands where a kept folder should be. */
const NOT_A_FOLDER_LOG = "a kept folder is not a plain folder; ignored"

/** What the log says when a kept folder is there without a readable file and facts. */
const UNREADABLE_LOG = "a kept copy is unreadable; ignored"

function isMissing(error: NodeJS.ErrnoException): boolean {
  return error.code === "ENOENT" || error.code === "ENOTDIR"
}

/** What is at `path` without following a link; undefined when nothing is. */
async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (isMissing(error)) return undefined
    throw error
  })
}

/** The names in a folder; none when there is none. */
async function namesIn(path: string): Promise<string[]> {
  return readdir(path).catch((error: NodeJS.ErrnoException) => {
    if (isMissing(error)) return []
    throw error
  })
}

/** Whether `path` is a real folder, not a link to one or a file. */
async function isPlainFolder(path: string): Promise<boolean> {
  return (await lstatOrUndefined(path))?.isDirectory() === true
}

/** The folder of a chat's kept messages, or undefined for an id that cannot name one. */
function chatFolderOf(kept: string, chat: string): string | undefined {
  return CHAT_FOLDER.test(chat) ? join(kept, chat) : undefined
}

/** The folder a message's file is kept in, or undefined for a chat or message that cannot name one. */
function messageFolderOf(kept: string, chat: string, id: number): string | undefined {
  const chatFolder = chatFolderOf(kept, chat)
  return chatFolder === undefined || !Number.isSafeInteger(id) || id <= 0 ? undefined : join(chatFolder, String(id))
}

/**
 * Makes the folder a file is downloaded into before it is kept:
 * `<kept>/<chat>/.<id>.<random>.part/`, mode 700, beside where it will stay.
 * Throws for a chat or message that cannot name a folder.
 */
export async function createKeptStaging(kept: string, chat: string, id: number): Promise<KeptStaging> {
  const chatFolder = chatFolderOf(kept, chat)
  const target = messageFolderOf(kept, chat, id)
  if (chatFolder === undefined || target === undefined) throw new Error("not a message that can be kept")
  await privateFolder(chatFolder)
  const dir = join(chatFolder, `.${id}.${randomBytes(STAGING_NAME_BYTES).toString("hex")}.part`)
  await newPrivateFolder(dir)
  return { dir, file: join(dir, DOWNLOADED_FILE_NAME), target }
}

/**
 * Keeps what was downloaded into `staging`: writes its facts, then renames the
 * folder into place in one step, so a copy is either complete or not there.
 * Fails, leaving the staging folder to the caller, when the message already has
 * a kept copy.
 */
export async function commitKept(staging: KeptStaging, meta: KeptMeta): Promise<void> {
  const handle = await open(join(staging.dir, META_FILE_NAME), "wx", FILE_MODE)
  try {
    await handle.writeFile(JSON.stringify(meta))
  } finally {
    await handle.close()
  }
  await rename(staging.dir, staging.target)
}

/** Removes a staging folder with what is in it, and the chat's folder too when that leaves it empty. */
export async function discardKeptStaging(staging: KeptStaging): Promise<void> {
  await rm(staging.dir, { recursive: true, force: true })
  await rmdir(dirname(staging.dir)).catch(() => {})
}

function isText(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}

/** The facts of a `meta.json`, or undefined when it is not what `commitKept` writes. */
function metaOf(value: unknown): KeptMeta | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const { name, type, kind, size, disappears_at } = value as Record<string, unknown>
  if (!isText(name) || !isText(type) || typeof kind !== "string" || !isCount(size)) return undefined
  if (disappears_at === undefined) return { name, type, kind, size }
  return isCount(disappears_at) ? { name, type, kind, size, disappears_at } : undefined
}

/** Reads a `meta.json`, refusing a link, a file that is not plain or large, and anything that is not its format. */
async function readMeta(path: string): Promise<KeptMeta | undefined> {
  const handle = await open(path, constants.O_RDONLY | NO_FOLLOW).catch((error: NodeJS.ErrnoException) => {
    if (isMissing(error) || error.code === "ELOOP") return undefined
    throw error
  })
  if (!handle) return undefined
  try {
    const found = await handle.stat()
    if (!found.isFile() || found.size > MAX_META_BYTES) return undefined
    try {
      return metaOf(JSON.parse(await handle.readFile("utf8")))
    } catch {
      return undefined
    }
  } finally {
    await handle.close()
  }
}

/** The kept copy in `dir`, or undefined when it has no plain `file` and valid `meta.json`. */
async function copyIn(dir: string): Promise<KeptCopy | undefined> {
  const file = join(dir, DOWNLOADED_FILE_NAME)
  const [found, meta] = await Promise.all([lstatOrUndefined(file), readMeta(join(dir, META_FILE_NAME))])
  return found?.isFile() && meta ? { file, meta, size: found.size } : undefined
}

/**
 * The kept copy of message `id` of `chat`, or undefined when there is none. A
 * link or a file where a folder should be, and a folder without a plain
 * `file` and a valid `meta.json`, are ignored (and logged): nothing is
 * followed, and the caller goes on as if nothing was kept.
 */
export async function findKept(
  kept: string,
  chat: string,
  id: number,
  log: (line: string) => void,
): Promise<KeptCopy | undefined> {
  const chatFolder = chatFolderOf(kept, chat)
  const dir = messageFolderOf(kept, chat, id)
  if (chatFolder === undefined || dir === undefined) return undefined
  try {
    for (const path of [kept, chatFolder, dir]) {
      const found = await lstatOrUndefined(path)
      if (!found) return undefined
      if (!found.isDirectory()) {
        log(NOT_A_FOLDER_LOG)
        return undefined
      }
    }
    const copy = await copyIn(dir)
    if (!copy) log(UNREADABLE_LOG)
    return copy
  } catch {
    log(UNREADABLE_LOG)
    return undefined
  }
}

/** Copies a kept file to the new file `destination` (mode 600, never over a name that exists), refusing a link as the source; resolves with the bytes copied. */
export async function copyKeptFile(source: string, destination: string): Promise<number> {
  const from = await open(source, constants.O_RDONLY | NO_FOLLOW)
  try {
    if (!(await from.stat()).isFile()) throw new Error("a kept file is not a plain file")
    const to = await open(destination, "wx", FILE_MODE)
    try {
      const buffer = Buffer.alloc(COPY_CHUNK_BYTES)
      let total = 0
      for (;;) {
        const { bytesRead } = await from.read(buffer, 0, buffer.length, null)
        if (bytesRead === 0) return total
        await writeAll(to, buffer.subarray(0, bytesRead))
        total += bytesRead
      }
    } finally {
      await to.close()
    }
  } finally {
    await from.close()
  }
}

/** Whether the mirror has the message. */
function hasMessage(mirror: Mirror, chat: string, id: number): boolean {
  return mirror.prepare("SELECT 1 FROM messages WHERE chat = ? AND id = ?").get(chat, id) !== undefined
}

/**
 * Removes the kept folders of `chat` whose message the mirror no longer has:
 * those of `ids`, or all of them without, and then the chat's folder too if it
 * is empty. Only real folders are entered, and what is removed is removed
 * itself, never what it points to. A staging folder (a copy being written) is
 * left alone.
 */
async function pruneChat(kept: string, mirror: Mirror, chat: string, ids?: readonly number[]): Promise<void> {
  const chatFolder = chatFolderOf(kept, chat)
  if (chatFolder === undefined || !(await isPlainFolder(kept)) || !(await isPlainFolder(chatFolder))) return
  const names = ids === undefined ? await namesIn(chatFolder) : ids.map(String)
  for (const name of names) {
    if (!MESSAGE_FOLDER.test(name) || hasMessage(mirror, chat, Number(name))) continue
    await rm(join(chatFolder, name), { recursive: true, force: true })
  }
  if (ids === undefined) await rmdir(chatFolder).catch(() => {})
}

/**
 * Removes the kept folders of messages the mirror no longer has: those of
 * `ids` in `chat`, those in every chat when `chat` is null, or all of the
 * chat's without `ids`.
 */
export async function pruneKept(
  kept: string,
  mirror: Mirror,
  { chat, ids }: { chat: string | null; ids?: readonly number[] },
): Promise<void> {
  const chats = chat !== null ? [chat] : (await isPlainFolder(kept)) ? await namesIn(kept) : []
  for (const name of chats) await pruneChat(kept, mirror, name, ids)
}

/**
 * Brings `kept/` to what the mirror has, at the start of the service, before
 * anything is kept: with `keeping` off it is removed whole; with it on, every
 * message folder the mirror has no row for goes, and so does anything that is
 * not one (a staging folder a killed service left, a link, a stray file).
 * Links are removed themselves, never followed.
 */
export async function sweepKept(kept: string, mirror: Mirror, keeping: boolean): Promise<void> {
  const found = await lstatOrUndefined(kept)
  if (!found) return
  if (!keeping || !found.isDirectory()) {
    await rm(kept, { recursive: true, force: true })
    return
  }
  for (const chat of await namesIn(kept)) {
    const chatFolder = join(kept, chat)
    if (!CHAT_FOLDER.test(chat) || !(await isPlainFolder(chatFolder))) {
      await rm(chatFolder, { recursive: true, force: true })
      continue
    }
    for (const name of await namesIn(chatFolder)) {
      const folder = join(chatFolder, name)
      if (!MESSAGE_FOLDER.test(name) || !(await isPlainFolder(folder))) {
        await rm(folder, { recursive: true, force: true })
      }
    }
    await pruneChat(kept, mirror, chat)
  }
}
