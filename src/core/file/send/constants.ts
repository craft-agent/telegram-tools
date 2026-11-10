/**
 * How long one file send may take, in milliseconds: the service uploads up to
 * 100 MB inside the call and ends an upload that moves no byte for 60
 * seconds, and a send can wait behind others in its queue first. As long as a
 * download's limit, since an upload over a slow line takes as long.
 */
export const SEND_FILES_TIMEOUT_MS = 30 * 60 * 1000

/** Said by a result Telegram accepted. */
export const FILES_ACCEPTED_NOTE = "Telegram accepted the files; that is not a read receipt."

/** Said by a result for a send Telegram had already received, when every file's message id is known. */
export const FILES_DUPLICATE_NOTE =
  "An earlier delivery of this same call had already gone out, so the files exist once. Do not send them again."

/** Said by a result for a send Telegram had already received, when the mirror does not have every file's message yet. */
export const FILES_DUPLICATE_PARTIAL_NOTE = `${FILES_DUPLICATE_NOTE} Ids are known only for the files listed in \`messages\` (none, when it is absent); \`telegram_chat_read\` shows the others once the service receives them.`
