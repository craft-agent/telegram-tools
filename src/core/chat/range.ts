import { parseTimeArgument } from "../time"

/** Exclusive bounds on a message's sent time, in milliseconds. */
export type TimeRange = { after?: number; before?: number }

/** The `after` and `before` arguments as times, or `invalid_argument` naming the one that is not a time. */
export function readRange(args: { after?: string; before?: string }): TimeRange {
  const range: TimeRange = {}
  if (args.after !== undefined) range.after = parseTimeArgument(args.after, "after")
  if (args.before !== undefined) range.before = parseTimeArgument(args.before, "before")
  return range
}

/** SQL conditions on `messages` for a range, and the parameters they take. */
export function rangeConditions(range: TimeRange): { conditions: string[]; params: number[] } {
  const conditions: string[] = []
  const params: number[] = []
  if (range.after !== undefined) {
    conditions.push("ts > ?")
    params.push(range.after)
  }
  if (range.before !== undefined) {
    conditions.push("ts < ?")
    params.push(range.before)
  }
  return { conditions, params }
}

/** The condition for the messages of a chat older than the message `id`, in the order newest first (by id, descending). */
export function olderThan(id: number): { condition: string; params: number[] } {
  return { condition: "id < ?", params: [id] }
}
