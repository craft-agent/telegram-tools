import { z } from "zod"
import { accountArgument } from "../chat/schema"
import { SYNC_LIST_LIMIT } from "../telegram/service-requests"

export { accountArgument }

/** The `size` of a result: how many chats the sync list holds. */
export const sizeField = z.number().int().nonnegative().describe("How many chats the sync list holds now.")

/** The `limit` of a result: the most chats the sync list holds. */
export const limitField = z.number().int().describe(`The most chats the sync list holds: ${SYNC_LIST_LIMIT}.`)

/** A list of chat ids in a result, described by `what`. */
export function chatIdsField(what: string) {
  return z.array(z.string()).describe(what)
}
