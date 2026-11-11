import { existingChat, requireChatId, topicTitle } from "../../chat/chat-rows"
import { chatFact } from "../../chat/facts"
import { pickPaths, readMirror } from "../../open"
import { sizeFact } from "../../facts"
import { checkedCaption } from "../../message/arguments"
import { replyFacts, topicFacts } from "../../message/facts"
import type { ChatKind } from "../../telegram/mirror-input"
import type { CallDescription, CallFact, CallHeadline, ToolContext } from "../../tool"
import { FILE_SEND_TOOL_ID } from "../constants"
import { hashResolved, type FileDigest } from "./hash-resolved"
import { resolveFiles, type ResolvedFile } from "./resolve-files"
import type { FileSendArguments } from "./schema"
import { assertApproved, type ByteBudget } from "./stage"

/** The `Files` fact: how many files a send carries, when it is more than one. */
function filesFact(count: number): CallFact {
  return { label: "Files", value: { text: "{count} files", values: { count } } }
}

/**
 * The approval headline of a send: the file's name when it carries one file,
 * the chat's name when the mirror has one, and Saved Messages for the user's
 * own chat. A chat without a name gets none, so the intent stands.
 */
function sendHeadline(
  files: readonly ResolvedFile[],
  chat: { kind: ChatKind; name: string | null },
): CallHeadline | undefined {
  const file = files.length === 1 ? files[0]!.name : undefined
  if (chat.kind === "self") {
    return file === undefined
      ? { text: "About to send files to Saved Messages" }
      : { text: "About to send {file} to Saved Messages", values: { file } }
  }
  if (chat.name === null) return undefined
  return file === undefined
    ? { text: "About to send files to {chat}", values: { chat: chat.name } }
    : { text: "About to send {file} to {chat}", values: { file, chat: chat.name } }
}

/**
 * What a file send says of itself for the approval prompt: the checks
 * `execute` makes on the arguments and the mirror (a call it would refuse
 * throws), the size limit `maxTotalBytes` and each caller's `sha256`, with each
 * file read once for its size and SHA-256. The pins are the hashes by real
 * path, so a file rewritten before the run is caught. The content inspection
 * stays in `execute`.
 */
export async function describeFileSend(
  args: FileSendArguments,
  ctx: ToolContext,
  maxTotalBytes: number,
): Promise<CallDescription> {
  const caption = checkedCaption(args.caption)
  const chat = requireChatId(args.chat, FILE_SEND_TOOL_ID)
  const paths = await pickPaths(ctx, args.account)
  const { row, title } = readMirror(paths, (mirror) => ({
    row: existingChat(mirror, chat),
    title: args.topic === undefined ? undefined : topicTitle(mirror, chat, args.topic),
  }))
  const files = await resolveFiles(args.files, ctx)
  const budget: ByteBudget = { used: 0, limit: maxTotalBytes }
  const digests: FileDigest[] = []
  for (const file of files) {
    const digest = await hashResolved(file, budget, ctx.signal)
    assertApproved(file.shown, file.sha256, digest.sha256)
    digests.push(digest)
  }

  const headline = sendHeadline(files, row)
  return {
    ...(headline && { headline }),
    facts: [
      chatFact(row.kind),
      ...topicFacts(args.topic, title),
      ...replyFacts(args.reply_to),
      ...(files.length > 1 ? [filesFact(files.length)] : []),
      sizeFact(digests.reduce((total, { size }) => total + size, 0)),
    ],
    ...(caption !== undefined && { text: { label: "Caption", body: caption } }),
    pins: Object.fromEntries(
      files.map((file, position) => [`sha256:${file.resolved.realPath}`, digests[position]!.sha256]),
    ),
  }
}
