import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Long, tl } from "@mtcute/core"
import {
  FAKE_ACCESS_HASH,
  FAKE_DATE,
  FAKE_DC_ID,
  FAKE_FILE_REFERENCE,
  FAKE_IDS,
  channelPeer,
  fakeMessage,
  fakeSelf,
  fakeSupergroup,
  fakeTopicReplyHeader,
  fakeUser,
  userPeer,
} from "./fake-telegram.testing"
import { callService } from "./service"
import type { SendFile, SendFilesResult } from "./service-requests"
import type { FakeFileRequest, FakeSend } from "./sync-client-send.testing"
import { SENT_DATE } from "./sync-send.testing"
import type { SyncFixture } from "./sync.testing"

const OUTBOX_MODE = 0o700

/** The made-up files the file send tests send: a name and its bytes. */
export const FILE_A = { name: "notes.txt", content: "first made-up file" }
export const FILE_B = { name: "data.bin", content: "second made-up file, a little longer" }
export const FILE_C = { name: "log.txt", content: "third made-up file" }

/** Writes a made-up file into the label's outbox; the path of it. */
export function writeOutboxFile(fixture: SyncFixture, name: string, content: string | Uint8Array): string {
  mkdirSync(fixture.paths.outbox, { recursive: true, mode: OUTBOX_MODE })
  const path = join(fixture.paths.outbox, name)
  writeFileSync(path, content)
  return path
}

/** Writes `file` into the outbox and gives it as a file of a send, under its own name. */
export function outboxFile(fixture: SyncFixture, file: { name: string; content: string }): SendFile {
  return { path: writeOutboxFile(fixture, file.name, file.content), name: file.name }
}

/** Asks the running service to send `params` as files. */
export function sendFiles(
  fixture: SyncFixture,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<SendFilesResult> {
  return callService<SendFilesResult>(fixture.paths.socket, "send_files", params, { effect: "write", signal })
}

/** Every call the service made while sending files, with the options it made it with. */
export function fileCallsOf(fixture: SyncFixture): FakeSend<FakeFileRequest>[] {
  return fixture.client.argsOf("call") as FakeSend<FakeFileRequest>[]
}

/** The calls of one request kind, in order. */
export function requestsOf<K extends FakeFileRequest["_"]>(
  fixture: SyncFixture,
  kind: K,
): FakeSend<Extract<FakeFileRequest, { _: K }>>[] {
  return fileCallsOf(fixture).filter((call) => call.request._ === kind) as FakeSend<
    Extract<FakeFileRequest, { _: K }>
  >[]
}

/** Where the answer puts the messages: a private chat, or a forum supergroup (in `topic` when given). */
export type FileAnswerSetup = {
  firstId: number
  forum?: boolean
  topic?: number
  /** The send itself never answers (until it is aborted), while the uploads and the documents do. */
  hangOnSend?: boolean
  /** The send itself fails with the error this gives, asked when the send arrives (to drop and regain the connection first). */
  failSend?: () => Error
  /** Changes the updates the send is answered with, to leave out or spoil a part of them. */
  alter?: (updates: tl.RawUpdates) => tl.TypeUpdates
}

/** One file of an answer: what the request named it by, and the message it becomes. */
type Answered = { randomId: Long; media: tl.RawMessageMediaDocument; caption: string }

/** Makes the fake answer the file send's calls the way Telegram does: documents for `uploadMedia`, an updates group for the send. */
export function answerFiles(
  fixture: Pick<SyncFixture, "client">,
  { firstId, forum = false, topic, hangOnSend = false, failSend, alter = (updates) => updates }: FileAnswerSetup,
): void {
  const mimes = new Map<string, string>()
  const documentOf = (id: Long): tl.RawMessageMediaDocument => {
    const upload = fixture.client.uploads.find((candidate) => candidate.id.eq(id))!
    return {
      _: "messageMediaDocument",
      document: {
        _: "document",
        id,
        accessHash: FAKE_ACCESS_HASH,
        fileReference: FAKE_FILE_REFERENCE,
        date: FAKE_DATE,
        mimeType: mimes.get(id.toString()) ?? "application/octet-stream",
        size: upload.bytes.length,
        dcId: FAKE_DC_ID,
        attributes: [{ _: "documentAttributeFilename", fileName: upload.fileName! }],
      },
    }
  }
  const updatesOf = (items: Answered[]): tl.RawUpdates => {
    const updates = items.flatMap(({ randomId, media, caption }, index): tl.TypeUpdate[] => {
      const id = firstId + index
      const message = fakeMessage({
        id,
        out: true,
        media,
        message: caption,
        date: SENT_DATE,
        ...(forum ? { peerId: channelPeer(), fromId: userPeer(FAKE_IDS.me) } : { fromId: undefined }),
        ...(forum && topic !== undefined ? { replyTo: fakeTopicReplyHeader(topic) } : {}),
      })
      const arrived = { message, pts: 41 + index, ptsCount: 1 }
      return [
        { _: "updateMessageID", id, randomId },
        forum ? { _: "updateNewChannelMessage", ...arrived } : { _: "updateNewMessage", ...arrived },
      ]
    })
    return {
      _: "updates",
      updates,
      users: [fakeUser(), fakeSelf()],
      chats: forum ? [fakeSupergroup({ forum: true })] : [],
      date: SENT_DATE,
      seq: 0,
    }
  }
  fixture.client.setFileAnswer(({ request }) => {
    if (request._ !== "messages.uploadMedia") {
      if (hangOnSend) return "hang"
      if (failSend) return failSend()
    }
    switch (request._) {
      case "messages.uploadMedia": {
        const { file, mimeType } = request.media as tl.RawInputMediaUploadedDocument
        mimes.set((file as tl.RawInputFile).id.toString(), mimeType)
        return documentOf((file as tl.RawInputFile).id)
      }
      case "messages.sendMedia": {
        const { file, mimeType } = request.media as tl.RawInputMediaUploadedDocument
        mimes.set((file as tl.RawInputFile).id.toString(), mimeType)
        return alter(
          updatesOf([
            { randomId: request.randomId, media: documentOf((file as tl.RawInputFile).id), caption: request.message },
          ]),
        )
      }
      case "messages.sendMultiMedia":
        return alter(
          updatesOf(
            request.multiMedia.map(({ media, randomId, message }) => ({
              randomId,
              media: documentOf(((media as tl.RawInputMediaDocument).id as tl.RawInputDocument).id),
              caption: message,
            })),
          ),
        )
    }
  })
}
