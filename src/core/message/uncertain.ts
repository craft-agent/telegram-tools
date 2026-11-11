import { readMirror } from "../open"
import { ToolError, type JsonValue } from "../errors"
import type { LabelPaths } from "../telegram/labels"
import { formatLocalTime } from "../time"
import { MAX_SENT_LIKE, SENT_LOOKBACK_MS } from "./constants"

/** A message of the user's that the mirror shows with the text of a send that ended `uncertain`. */
type SentLike = { id: number; time: string }

/**
 * The user's own messages in `chat` whose text is `text`, dated from
 * `SENT_LOOKBACK_MS` before `startedAt` on, newest first, at most
 * `MAX_SENT_LIKE`. A message deleted for everyone has no row in the mirror.
 */
function sentLike(paths: Pick<LabelPaths, "mirror">, chat: string, text: string, startedAt: number): SentLike[] {
  const rows = readMirror(
    paths,
    (mirror) =>
      mirror
        .prepare(
          "SELECT id, ts FROM messages WHERE chat = ? AND from_me = 1 AND body = ? AND ts >= ? ORDER BY ts DESC, id DESC LIMIT ?",
        )
        .all(chat, text, startedAt - SENT_LOOKBACK_MS, MAX_SENT_LIKE) as { id: number; ts: number }[],
  )
  return rows.map(({ id, ts }) => ({ id, time: formatLocalTime(ts) }))
}

/** What the mirror's finding adds to an `uncertain` send's message. */
function sentence(count: number): string {
  if (count === 0) return "The mirror shows none of yours with this text yet; it may still arrive."
  return count === 1
    ? "The mirror shows 1 message of yours with this text since the send began; check it in Telegram."
    : `The mirror shows ${count} messages of yours with this text since the send began; check them in Telegram.`
}

/**
 * An `uncertain` send's error with what the mirror shows added: what `find`
 * reads from it, as `details.sent_like_this`, and `describe`'s sentence for
 * how many it found. It decides nothing, so the code stays `uncertain`. When
 * `find` fails (the mirror cannot be read) the error is returned as it is.
 */
export function withFound<T extends Record<string, JsonValue>>(
  error: ToolError,
  find: () => T[],
  describe: (count: number) => string,
): ToolError {
  let found: T[]
  try {
    found = find()
  } catch {
    return error
  }
  return new ToolError("uncertain", `${error.message} ${describe(found.length)}`, {
    ...("cause" in error && { cause: error.cause }),
    details: { ...error.details, sent_like_this: found },
  })
}

/**
 * An `uncertain` send's error with what the mirror shows added: the user's own
 * messages in the chat with the same text since the send began, by id and time,
 * as `details.sent_like_this`. It decides nothing, so the code stays
 * `uncertain`. When the mirror cannot be read the error is returned as it is.
 */
export function withSentLike(
  error: ToolError,
  paths: Pick<LabelPaths, "mirror">,
  chat: string,
  text: string,
  startedAt: number,
): ToolError {
  return withFound(error, () => sentLike(paths, chat, text, startedAt), sentence)
}
