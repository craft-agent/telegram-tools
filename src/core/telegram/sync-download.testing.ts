import { existsSync, readdirSync } from "node:fs"
import type { Message, tl } from "@mtcute/core"
import { fakeDocumentMedia } from "./fake-telegram-media.testing"
import { channelPeer, fakeMessage, fakeSupergroup, fakeUser, messageOf, userPeer } from "./fake-telegram.testing"
import type { DownloadResult } from "./service-requests"
import { FORUM, request } from "./sync-requests.testing"
import type { SyncFixture } from "./sync.testing"

/** The chat the download tests read: a supergroup the mirror lists and does not keep. */
export const CHAT = FORUM

/** A file of `size` declared bytes with a name (none when `null`) and a MIME type, as Telegram describes a document. */
export function fileMedia(name: string | null, mimeType: string, size: number): tl.RawMessageMediaDocument {
  const media = fakeDocumentMedia()
  const document = media.document as tl.RawDocument
  const attributes: tl.TypeDocumentAttribute[] = name ? [{ _: "documentAttributeFilename", fileName: name }] : []
  return { ...media, document: { ...document, mimeType, size, attributes } }
}

/** A message of the supergroup `CHAT` with `media`, as Telegram brings it. */
export function mediaMessage(id: number, media: tl.TypeMessageMedia | undefined, overrides = {}): Message {
  const raw = fakeMessage({ id, peerId: channelPeer(), fromId: userPeer(), media, ...overrides })
  return messageOf(raw, fakeUser(), fakeSupergroup())
}

/** A message of the kept chat `KEPT` with `media`. */
export function keptMediaMessage(id: number, media: tl.TypeMessageMedia): Message {
  return messageOf(fakeMessage({ id, media }), fakeUser())
}

/** Asks the running service to download message `id` of `chat` with a limit of `max_bytes`. */
export function download(
  fixture: SyncFixture,
  id: number,
  max_bytes: number,
  chat: string = CHAT,
  signal?: AbortSignal,
): Promise<DownloadResult> {
  return request<DownloadResult>(fixture, "download", { chat, id, max_bytes }, signal)
}

/** The folders in the label's `incoming/`, by name; none while it does not exist. */
export function incomingFolders(fixture: SyncFixture): string[] {
  return existsSync(fixture.paths.incoming) ? readdirSync(fixture.paths.incoming) : []
}
