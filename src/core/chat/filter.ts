import { createHash } from "node:crypto"

const FILTER_LENGTH = 16

/**
 * A short stand-in for the arguments a paged call was made under, kept in its
 * cursor so that the cursor continues that call and no other, and so that a
 * long query does not outgrow the room a cursor has.
 */
export function fingerprint(...parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("base64url").slice(0, FILTER_LENGTH)
}
