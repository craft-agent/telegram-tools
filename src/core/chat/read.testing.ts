import { mkdirSync, rmSync } from "node:fs"
import type { z } from "zod"
import { ToolError } from "../errors"
import { setFollowed, upsertChats } from "../telegram/ingest-chats"
import { storeMessage } from "../telegram/ingest-messages"
import { labelPaths } from "../telegram/labels"
import { inTransaction, openMirrorForWrite, type Mirror } from "../telegram/mirror"
import type { ChatInput, MessageInput } from "../telegram/mirror-input"
import {
  CHANNEL,
  GROUP,
  NOW,
  OTHER_USER,
  SUPERGROUP,
  USER,
  chatInput,
  makeTempDir,
  messageInput,
} from "../telegram/mirror.testing"
import { invoke } from "../tool"
import type { MessageEntry } from "./message-schema"
import { telegramChatRead } from "./read"
import type { output } from "./schema"

/** One minute in milliseconds, the step between the messages of a test. */
export const MINUTE = 60_000

/** The time of the `n`th message of a test: one a minute, the first at `NOW`. */
export const at = (n: number) => NOW + n * MINUTE

/** A linked label with a mirror a test fills through the ingest functions, and the tool to read it. */
export type ChatFixture = {
  stateDir: string
  mirror: Mirror
  /** Upserts a chat without following it, so the mirror knows it and keeps none of its messages. */
  known(overrides?: Partial<ChatInput>): ChatInput
  /** Upserts a chat and follows it, so that its messages are stored. */
  follow(overrides?: Partial<ChatInput>): ChatInput
  /** Stores each message in a transaction of its own, received at `NOW`. */
  store(...messages: Partial<MessageInput>[]): void
  /** The same for one message, received at `now`, with `keepDisappearing` as given. */
  storeAt(now: number, message: Partial<MessageInput>, keepDisappearing?: boolean): void
  /** The messages of a chat as `view` returns them. */
  messages(chat: string, args?: Record<string, unknown>): Promise<MessageEntry[]>
  /** Calls the tool. */
  read(args: unknown): Promise<z.output<typeof output>>
  /** The error a call throws. */
  failure(args: unknown): Promise<ToolError>
  /** Closes the test's own writing connection, as when the sync service has stopped. */
  closeMirror(): void
  /** Removes the state directory. */
  close(): void
}

/** A state directory with one logged-in label `default` and an empty mirror. */
export function createChatFixture(): ChatFixture {
  const stateDir = makeTempDir()
  const paths = labelPaths(stateDir, "default")
  mkdirSync(paths.dir)
  const mirror = openMirrorForWrite(paths.mirror)
  let open = true
  const storeAt = (now: number, message: Partial<MessageInput>, keepDisappearing = false) => {
    inTransaction(mirror, () => storeMessage(mirror, { now, keepDisappearing }, messageInput(message)))
  }
  const read = (args: unknown) => invoke(telegramChatRead, args, { cwd: stateDir, stateDir })
  const closeMirror = () => {
    if (open) mirror.close()
    open = false
  }
  return {
    stateDir,
    mirror,
    known(overrides) {
      const chat = chatInput(overrides)
      upsertChats(mirror, [chat], NOW)
      return chat
    },
    follow(overrides) {
      const chat = chatInput(overrides)
      upsertChats(mirror, [chat], NOW)
      setFollowed(mirror, chat.id, true)
      return chat
    },
    store(...messages) {
      for (const message of messages) storeAt(NOW, message)
    },
    storeAt,
    async messages(chat, args = {}) {
      return (await read({ method: "view", chat, ...args })).messages ?? []
    },
    read,
    async failure(args) {
      try {
        await read(args)
      } catch (error) {
        if (error instanceof ToolError) return error
        throw error
      }
      throw new Error("Expected the call to fail")
    },
    closeMirror,
    close() {
      closeMirror()
      rmSync(stateDir, { recursive: true, force: true })
    },
  }
}

/** A message from the user's own account in `USER`'s chat: no sender, as Telegram gives it. */
export function outgoing(overrides: Partial<MessageInput> = {}): Partial<MessageInput> {
  return { fromMe: true, sender: null, senderName: null, ...overrides }
}

/**
 * Five chats, newest activity first: Alice (`USER`, 5000, one unread), Bob
 * (`OTHER_USER`, 3000, one unread), the group Team Chat (`GROUP`, 2000, one
 * unread), the left supergroup Old Friends (`SUPERGROUP`, 1000, known and not
 * mirrored) and the channel News (`CHANNEL`, no activity, not mirrored).
 */
export function fillSampleChats(t: Pick<ChatFixture, "known" | "follow" | "store">): void {
  t.follow({ id: USER, name: "Alice Example", username: "alice_example" })
  t.follow({ id: OTHER_USER, name: "Bob Example", username: "bob_example" })
  t.follow({ id: GROUP, kind: "group", name: "Team Chat", username: null })
  t.known({ id: SUPERGROUP, kind: "supergroup", name: "Old Friends", username: null, left: true, lastTs: 1000 })
  t.known({ id: CHANNEL, kind: "channel", name: "News", username: "news_example" })
  t.store(
    { chat: USER, id: 1, ts: 5000, body: "hello from Alice" },
    { chat: OTHER_USER, id: 2, ts: 3000, sender: OTHER_USER, senderName: "Bob Example", body: "hello from Bob" },
    { chat: GROUP, id: 3, ts: 2000, sender: USER, body: "hello team" },
  )
}
