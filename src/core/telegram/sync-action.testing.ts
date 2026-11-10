import type { tl } from "@mtcute/core"
import {
  FAKE_DATE,
  FAKE_IDS,
  channelPeer,
  fakeMessage,
  fakeSelf,
  fakeSupergroup,
  fakeUser,
  userPeer,
} from "./fake-telegram.testing"
import { storeMessage } from "./ingest-messages"
import { deleteMessages } from "./ingest-delete"
import type { MessageInput } from "./mirror-input"
import { messageInput } from "./mirror.testing"
import { callService } from "./service"
import type { DeleteResult, EditResult } from "./service-requests"
import type { FakeActionRequest, FakeSend } from "./sync-client-send.testing"
import { FORUM, KEPT } from "./sync-requests.testing"
import { seedSendChats } from "./sync-send.testing"
import { START_MS, type SyncFixture } from "./sync.testing"

/** The text of the user's own messages the action tests start from. */
export const OWN_TEXT = "The text before"

/** The text an edit test gives them. */
export const NEW_TEXT = "The text after"

/** The Unix second Telegram stamps an edit with. */
export const EDIT_DATE = FAKE_DATE + 200

/** The same moment in milliseconds, as a result gives it. */
export const EDIT_MS = EDIT_DATE * 1000

/** The user's own messages of `KEPT`: plain text, a photo with a caption, a photo with none, a link preview, a service message, and one deleted for everyone. */
export const OWN = { text: 10, photo: 11, bare: 12, preview: 13, service: 14, deleted: 15 }

/** A message of `KEPT` that someone else wrote; the seeded chats hold messages 1 to 3. */
export const THEIRS = 1

/** The user's own message in `FORUM`, a supergroup the mirror keeps. */
export const OWN_IN_FORUM = 20

/** What `seedActionChats` adds to the send tests' chats. */
const OWN_MESSAGES: Partial<MessageInput>[] = [
  { chat: KEPT, id: OWN.text },
  { chat: KEPT, id: OWN.photo, media: { type: "photo" } },
  { chat: KEPT, id: OWN.bare, media: { type: "photo" }, body: null },
  { chat: KEPT, id: OWN.preview, media: { type: "webpage", url: "https://example.test/" } },
  { chat: KEPT, id: OWN.service, kind: "service", body: null, action: { type: "pinned" } },
  { chat: FORUM, id: OWN_IN_FORUM },
]

/**
 * Lists the send tests' chats, with the forum supergroup kept, and the user's
 * own messages the actions work on; message `OWN.deleted` is one the mirror was
 * told was deleted for everyone.
 */
export function seedActionChats(fixture: SyncFixture): void {
  seedSendChats(fixture, { mirrorForum: true })
  fixture.seed((mirror) => {
    const ingest = { now: START_MS, keepDisappearing: false }
    for (const own of OWN_MESSAGES) {
      storeMessage(
        mirror,
        ingest,
        messageInput({ fromMe: true, sender: null, senderName: null, body: OWN_TEXT, ts: START_MS - 10_000, ...own }),
      )
    }
    deleteMessages(mirror, ingest, { chat: KEPT, ids: [OWN.deleted] })
  })
}

/** Asks the running service to edit `params`. */
export function edit(fixture: SyncFixture, params: Record<string, unknown>, signal?: AbortSignal): Promise<EditResult> {
  return callService<EditResult>(fixture.paths.socket, "edit", params, { effect: "write", signal })
}

/** Asks the running service to delete `params`. */
export function remove(
  fixture: SyncFixture,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<DeleteResult> {
  return callService<DeleteResult>(fixture.paths.socket, "delete", params, { effect: "write", signal })
}

/** Every call the service made to edit or delete, with the options it made it with. */
export function actionsOf(fixture: SyncFixture): FakeSend<FakeActionRequest>[] {
  return fixture.client.argsOf("call") as FakeSend<FakeActionRequest>[]
}

/** The answer to an edit of message `id` in `KEPT`: the updates group with the message as it is now. */
export function editedInPrivate(id: number, text: string): tl.RawUpdates {
  const message = fakeMessage({ id, out: true, fromId: undefined, message: text, date: FAKE_DATE, editDate: EDIT_DATE })
  return {
    _: "updates",
    updates: [{ _: "updateEditMessage", message, pts: 50, ptsCount: 1 }],
    users: [fakeUser(), fakeSelf()],
    chats: [],
    date: EDIT_DATE,
    seq: 0,
  }
}

/** The answer to an edit of message `id` in `FORUM`. */
export function editedInForum(id: number, text: string): tl.RawUpdates {
  const message = fakeMessage({
    id,
    out: true,
    peerId: channelPeer(),
    fromId: userPeer(FAKE_IDS.me),
    message: text,
    date: FAKE_DATE,
    editDate: EDIT_DATE,
  })
  return {
    _: "updates",
    updates: [{ _: "updateEditChannelMessage", message, pts: 51, ptsCount: 1 }],
    users: [fakeUser(), fakeSelf()],
    chats: [fakeSupergroup({ forum: true })],
    date: EDIT_DATE,
    seq: 0,
  }
}

/** What Telegram answers a delete with: the events it counted, and the state they moved to. */
export function affected(ptsCount = 1, pts = 60): tl.messages.RawAffectedMessages {
  return { _: "messages.affectedMessages", pts, ptsCount }
}
