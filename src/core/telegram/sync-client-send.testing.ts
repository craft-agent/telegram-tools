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

/** What `call` answers with: a response, an error it throws, or nothing until the call is aborted (the abort reason is thrown). */
export type FakeCallAnswer = tl.TypeUpdates | Error | "hang"

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
  /** Everything `handleClientUpdate` was given, in order. */
  handled: { update: tl.TypeUpdates; noDispatch?: boolean }[]
  resolvePeer(chat: number): Promise<tl.TypeInputPeer>
  call(request: tl.messages.RawSendMessageRequest | FakeFileRequest, options?: RpcCallOptions): Promise<tl.TypeUpdates>
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
  const handled: FakeSendMethods["handled"] = []
  return {
    handled,
    setCallAnswer: (next) => void (script = next),
    setFileAnswer: (next) => void (fileScript = next),
    async resolvePeer(chat) {
      record("resolvePeer", chat)
      return inputPeerOf(chat)
    },
    async call(request, options = {}) {
      record("call", { request, options })
      const answer =
        request._ === "messages.sendMessage"
          ? typeof script === "function"
            ? await script({ request, options })
            : script
          : await fileScript({ request, options })
      if (answer === "hang") await untilAborted(options.abortSignal)
      if (answer instanceof Error) throw answer
      return answer as tl.TypeUpdates
    },
    handleClientUpdate(update, noDispatch) {
      record("handleClientUpdate", update)
      handled.push({ update, noDispatch })
    },
  }
}
