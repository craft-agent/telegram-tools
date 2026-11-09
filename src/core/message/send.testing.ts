import type { z } from "zod"
import type { ServiceCalls } from "../chat/read.testing"
import type { ToolError } from "../errors"
import { createSyncFixture, type SyncFixture } from "../sync/sync.testing"
import { USER } from "../telegram/mirror.testing"
import { telegramMessageSend } from "./send"
import type { output } from "./schema"

/** What a send test serves when it asks for nothing else: Telegram accepted the message. */
export const ACCEPTED = { id: 7, date: 1_800_000_000_000 }

/** A sync fixture and the way to call `telegram_message_send` in it, as an entry point would. */
export type SendFixture = SyncFixture & {
  /** Calls the tool for `USER`'s chat with the text "hello", each argument overridden by `args`. */
  send(args?: Record<string, unknown>): Promise<z.output<typeof output>>
  /** The error a call throws. */
  sendFails(args?: Record<string, unknown>): Promise<ToolError>
  /** Serves the label's socket with a `send` handler, which accepts the message unless `answer` says otherwise; resolves with the requests it receives. */
  serveSend(answer?: (params: unknown) => unknown): Promise<ServiceCalls>
}

/** A state directory with one logged-in label `default` and an empty mirror, and the send tool to run in it. */
export function createSendFixture(): SendFixture {
  const t = createSyncFixture()
  const withDefaults = (args: Record<string, unknown>) => ({ chat: USER, text: "hello", ...args })
  return Object.assign(t, {
    send: (args: Record<string, unknown> = {}) => t.run(telegramMessageSend, withDefaults(args)),
    sendFails: (args: Record<string, unknown> = {}) => t.fail(telegramMessageSend, withDefaults(args)),
    serveSend: (answer: (params: unknown) => unknown = () => ACCEPTED) => t.serve({ send: answer }),
  })
}
