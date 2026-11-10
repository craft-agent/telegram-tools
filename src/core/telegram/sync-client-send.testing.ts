import { tl, type RpcCallOptions } from "@mtcute/core"
import { FAKE_ACCESS_HASH } from "./fake-telegram.testing"
import type { FakeMethod } from "./sync-client.testing"
import { untilAborted } from "./sync-client-upload.testing"

/** The first marked id of a supergroup or channel, minus the sign: bare channel ids are written after `-100`. */
const CHANNEL_BASE = 1_000_000_000_000

/** A send as the fake received it: the request, and the options it was made with. */
export type FakeSend<Request = tl.messages.RawSendMessageRequest> = { request: Request; options: RpcCallOptions }

/** The calls a file send makes: the media made of an upload, and the one send. */
export type FakeFileRequest =
  tl.messages.RawUploadMediaRequest | tl.messages.RawSendMediaRequest | tl.messages.RawSendMultiMediaRequest

/** The calls an action makes: an edit, a delete, a reaction or a pin of one message, or a read mark of a chat or a topic. */
export type FakeActionRequest =
  | tl.messages.RawEditMessageRequest
  | tl.messages.RawDeleteMessagesRequest
  | tl.channels.RawDeleteMessagesRequest
  | tl.messages.RawSendReactionRequest
  | tl.messages.RawUpdatePinnedMessageRequest
  | tl.messages.RawReadHistoryRequest
  | tl.channels.RawReadHistoryRequest
  | tl.messages.RawReadDiscussionRequest

/** What `call` answers with: a response, an error it throws, or nothing until the call is aborted (the abort reason is thrown). */
export type FakeCallAnswer = tl.TypeUpdates | Error | "hang"

/** What `call` answers an action with: the updates of an edit, a reaction or a pin, the count of a delete or a read mark, a bool, an error it throws, or nothing until the call is aborted. */
export type FakeActionAnswer = tl.TypeUpdates | tl.messages.TypeAffectedMessages | boolean | Error | "hang"

/** How `call` answers an action: one answer for every call, or one worked out from the request. */
export type FakeActionScript =
  FakeActionAnswer | ((send: FakeSend<FakeActionRequest>) => FakeActionAnswer | Promise<FakeActionAnswer>)

/** How `call` answers: one answer for every call, or one worked out from the request (to echo its `random_id`). */
export type FakeCallScript = FakeCallAnswer | ((send: FakeSend) => FakeCallAnswer | Promise<FakeCallAnswer>)

/** How `call` answers a file send's requests: the media of `messages.uploadMedia`, the updates of the sends. */
export type FakeFileScript = (
  send: FakeSend<FakeFileRequest>,
) => FakeCallAnswer | tl.TypeMessageMedia | Promise<FakeCallAnswer | tl.TypeMessageMedia>

/** What the fake adds for sending: `call`, `resolvePeer` and `handleClientUpdate`, scripted and recorded. */
export type FakeSendMethods = {
  /** Sets how every later `call` of a text send answers; an error is thrown by it. */
  setCallAnswer(script: FakeCallScript): void
  /** Sets how every later `call` of a file send's requests answers; an error is thrown by it. */
  setFileAnswer(script: FakeFileScript): void
  /** Sets how every later `call` of an edit, a delete, a reaction, a pin or a read mark answers; an error is thrown by it. */
  setActionAnswer(script: FakeActionScript): void
  /** Everything `handleClientUpdate` was given, in order. */
  handled: { update: tl.TypeUpdates; noDispatch?: boolean }[]
  resolvePeer(chat: number): Promise<tl.TypeInputPeer>
  call(
    request: tl.messages.RawSendMessageRequest | FakeFileRequest | FakeActionRequest,
    options?: RpcCallOptions,
  ): Promise<tl.TypeUpdates | tl.messages.TypeAffectedMessages | boolean>
  handleClientUpdate(update: tl.TypeUpdates, noDispatch?: boolean): void
}

/** An error as mtcute raises it from a server answer, with the seconds taken out of a wait's name. */
export const answered = (code: number, text: string) => tl.RpcError.fromTl({ errorCode: code, errorMessage: text })

/** The peer a marked id stands for: a user for a positive one, a channel below `-100…`, else a basic group. */
function inputPeerOf(chat: number): tl.TypeInputPeer {
  if (chat > 0) return { _: "inputPeerUser", userId: chat, accessHash: FAKE_ACCESS_HASH }
  if (chat < -CHANNEL_BASE) {
    return { _: "inputPeerChannel", channelId: -CHANNEL_BASE - chat, accessHash: FAKE_ACCESS_HASH }
  }
  return { _: "inputPeerChat", chatId: -chat }
}

/** The send methods of the fake client; `record` is the fake's own, which notes a call and throws a scripted failure. */
export function fakeSendMethods(record: (method: FakeMethod, arg?: unknown) => void): FakeSendMethods {
  let script: FakeCallScript = new Error("no answer was scripted")
  let fileScript: FakeFileScript = () => new Error("no answer was scripted")
  let actionScript: FakeActionScript = new Error("no answer was scripted")
  const handled: FakeSendMethods["handled"] = []

  /** What the script of the request's kind answers it with. */
  async function answerOf(
    request: tl.messages.RawSendMessageRequest | FakeFileRequest | FakeActionRequest,
    options: RpcCallOptions,
  ): Promise<FakeActionAnswer | FakeCallAnswer | tl.TypeMessageMedia> {
    switch (request._) {
      case "messages.sendMessage":
        return typeof script === "function" ? script({ request, options }) : script
      case "messages.editMessage":
      case "messages.deleteMessages":
      case "channels.deleteMessages":
      case "messages.sendReaction":
      case "messages.updatePinnedMessage":
      case "messages.readHistory":
      case "channels.readHistory":
      case "messages.readDiscussion":
        return typeof actionScript === "function" ? actionScript({ request, options }) : actionScript
      default:
        return fileScript({ request, options })
    }
  }

  return {
    handled,
    setCallAnswer: (next) => void (script = next),
    setFileAnswer: (next) => void (fileScript = next),
    setActionAnswer: (next) => void (actionScript = next),
    async resolvePeer(chat) {
      record("resolvePeer", chat)
      return inputPeerOf(chat)
    },
    async call(request, options = {}) {
      record("call", { request, options })
      const answer = await answerOf(request, options)
      if (answer === "hang") await untilAborted(options.abortSignal)
      if (answer instanceof Error) throw answer
      return answer as tl.TypeUpdates | tl.messages.TypeAffectedMessages | boolean
    },
    handleClientUpdate(update, noDispatch) {
      record("handleClientUpdate", update)
      handled.push({ update, noDispatch })
    },
  }
}
