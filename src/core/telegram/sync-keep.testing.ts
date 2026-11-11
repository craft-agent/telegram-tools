import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Message, tl } from "@mtcute/core"
import { fakeVideoMedia } from "./fake-telegram-media.testing"
import { FAKE_VIEW_ONCE_TTL, fakeMessage, fakeUser, messageOf, type Overrides } from "./fake-telegram.testing"
import type { KeptMeta } from "./sync-kept-store"
import { fileMedia } from "./sync-download.testing"
import { eventually, type SyncFixture } from "./sync.testing"

/** The bytes a test's download serves. */
export const CHUNK = Uint8Array.of(1, 2, 3)

/** The permission bits of a file or folder, without its file type. */
export const modeOf = (path: string) => statSync(path).mode & 0o777

/** A new message from Alice with `media`, as Telegram pushes it. */
export function arriving(id: number, media: tl.TypeMessageMedia, overrides: Overrides<tl.RawMessage> = {}): Message {
  return messageOf(fakeMessage({ id, media, ...overrides }), fakeUser())
}

/** A file that can be opened once, with the name, type and size its sender declares. */
export function viewOnceFile(name: string | null, type: string, size: number): tl.RawMessageMediaDocument {
  return { ...fileMedia(name, type, size), ttlSeconds: FAKE_VIEW_ONCE_TTL }
}

/**
 * A video that destroys itself 10 seconds after it is opened, `clip.mp4`. Its
 * length is whole seconds: the mirror takes no other (a real video's is
 * fractional, and the mirror then skips its message).
 */
export function selfDestructingVideo(): tl.RawMessageMediaDocument {
  const media = fakeVideoMedia({ ttlSeconds: 10 })
  const document = media.document as tl.RawDocument
  document.attributes = [
    { _: "documentAttributeVideo", duration: 13, w: 1280, h: 720 },
    { _: "documentAttributeFilename", fileName: "clip.mp4" },
  ]
  return media
}

/** Pushes a new message to the running service, as the client does. */
export function push(fixture: SyncFixture, message: Message): void {
  fixture.client.onNewMessage.emit(message)
}

/** Where the file of message `id` of `chat` is kept. */
export function keptFolder(fixture: SyncFixture, chat: string, id: number): string {
  return join(fixture.paths.kept, chat, String(id))
}

/** Everything under the label's `kept/`, as paths relative to it and in order; none while there is no such folder. */
export function keptTree(fixture: SyncFixture): string[] {
  return existsSync(fixture.paths.kept) ? (readdirSync(fixture.paths.kept, { recursive: true }) as string[]).sort() : []
}

/** Waits until the file of message `id` of `chat` is kept: the folder appears whole, or not at all. */
export function waitKept(fixture: SyncFixture, chat: string, id: number): Promise<void> {
  return eventually(() => existsSync(join(keptFolder(fixture, chat, id), "meta.json")))
}

/** Writes a kept copy the way the service does, for a test to start from; returns the message's folder. */
export function writeKept(
  fixture: SyncFixture,
  chat: string,
  id: number,
  bytes: Uint8Array = CHUNK,
  meta: Partial<KeptMeta> = {},
): string {
  const folder = keptFolder(fixture, chat, id)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, "file"), bytes)
  const facts: KeptMeta = { name: "a.txt", type: "text/plain", kind: "document", size: bytes.length, ...meta }
  writeFileSync(join(folder, "meta.json"), JSON.stringify(facts))
  return folder
}
