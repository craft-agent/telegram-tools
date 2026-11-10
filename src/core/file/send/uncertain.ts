import { readMirror } from "../../chat/open"
import type { ToolError } from "../../errors"
import { MAX_SENT_LIKE, SENT_LOOKBACK_MS } from "../../message/constants"
import { withFound } from "../../message/uncertain"
import type { LabelPaths } from "../../telegram/labels"
import type { FileFacts } from "../../telegram/sync-send-mirror"
import { formatLocalTime } from "../../time"

/** A message of the user's that the mirror shows with the name and size of a file of a send that ended `uncertain`. */
type SentFileLike = { id: number; time: string; name: string }

/** One file's match on a message's media: its name and size, as the mirror stores them. */
const SAME_FILE = "(json_extract(media, '$.name') = ? AND json_extract(media, '$.size') = ?)"

/**
 * The user's own messages in `chat` that carry a file of one of `files`' name
 * and size, dated from `SENT_LOOKBACK_MS` before `startedAt` on, newest first,
 * at most `MAX_SENT_LIKE`. A message deleted for everyone has no row in the
 * mirror.
 */
function sentFilesLike(
  paths: Pick<LabelPaths, "mirror">,
  chat: string,
  files: readonly FileFacts[],
  startedAt: number,
): SentFileLike[] {
  const rows = readMirror(
    paths,
    (mirror) =>
      mirror
        .prepare(
          `SELECT id, ts, json_extract(media, '$.name') AS name FROM messages
             WHERE chat = ? AND from_me = 1 AND ts >= ? AND (${files.map(() => SAME_FILE).join(" OR ")})
             ORDER BY ts DESC, id DESC LIMIT ?`,
        )
        .all(chat, startedAt - SENT_LOOKBACK_MS, ...files.flatMap(({ name, size }) => [name, size]), MAX_SENT_LIKE) as {
        id: number
        ts: number
        name: string
      }[],
  )
  return rows.map(({ id, ts, name }) => ({ id, time: formatLocalTime(ts), name }))
}

/** What the mirror's finding adds to an `uncertain` file send's message. */
function sentence(count: number): string {
  const same = "with a file of the same name and size"
  if (count === 0) return `The mirror shows none of yours ${same} yet; they may still arrive.`
  return count === 1
    ? `The mirror shows 1 message of yours ${same} since the send began; check it in Telegram.`
    : `The mirror shows ${count} messages of yours ${same} since the send began; check them in Telegram.`
}

/**
 * An `uncertain` file send's error with what the mirror shows added: the
 * user's own messages in the chat with a file of the same name and size as one
 * of `files` since the send began, by id, time and name, as
 * `details.sent_like_this`. It decides nothing, so the code stays `uncertain`.
 * When the mirror cannot be read the error is returned as it is.
 */
export function withSentFilesLike(
  error: ToolError,
  paths: Pick<LabelPaths, "mirror">,
  chat: string,
  files: readonly FileFacts[],
  startedAt: number,
): ToolError {
  return withFound(error, () => sentFilesLike(paths, chat, files, startedAt), sentence)
}
