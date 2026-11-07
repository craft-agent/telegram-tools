import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setFollowed, upsertChats } from "./ingest-chats"
import { openMirrorForWrite, type Mirror } from "./mirror"
import type { ChatInput, DeleteInput, IngestContext, MessageInput } from "./mirror-input"

/** Made-up chat ids for tests: a person, a basic group, a supergroup and a channel. */
export const USER = "1000000001"
export const OTHER_USER = "1000000002"
export const GROUP = "-4000000001"
export const SUPERGROUP = "-1001000000001"
export const CHANNEL = "-1001000000002"

/** A fixed time for tests, in milliseconds. */
export const NOW = 1_800_000_000_000

/** A mirror in a fresh temp directory. */
export type TestMirror = {
  dir: string
  path: string
  mirror: Mirror
  /** The ingest context at `now` (default `NOW`), with `keepDisappearing` off unless given. */
  ctx(now?: number, keepDisappearing?: boolean): IngestContext
  /** Closes the mirror and removes the directory. */
  close(): void
}

/** Where a test keeps files, in a fresh temp directory; remove it with `rmSync`. */
export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "tg-"))
}

/** Opens a new mirror for writing in a temp directory. */
export function createTestMirror(): TestMirror {
  const dir = makeTempDir()
  const path = join(dir, "mirror.sqlite")
  const mirror = openMirrorForWrite(path)
  return {
    dir,
    path,
    mirror,
    ctx: (now = NOW, keepDisappearing = false) => ({ now, keepDisappearing }),
    close() {
      mirror.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** A private chat, with fields to override. */
export function chatInput(overrides: Partial<ChatInput> = {}): ChatInput {
  return { id: USER, kind: "user", name: "Alice Example", username: "alice_example", ...overrides }
}

/** A text message in `USER`'s chat, with fields to override. */
export function messageInput(overrides: Partial<MessageInput> = {}): MessageInput {
  return {
    chat: USER,
    id: 1,
    topic: null,
    ts: NOW - 60_000,
    fromMe: false,
    sender: USER,
    senderName: "Alice Example",
    kind: "message",
    body: "hello",
    entities: [],
    media: null,
    action: null,
    reply: null,
    forward: null,
    grouped: null,
    reactions: null,
    edited: null,
    ttl: null,
    viewOnce: false,
    selfDestruct: null,
    ...overrides,
  }
}

/** A delete for everyone of message 1 in `USER`'s chat, with fields to override. */
export function deleteInput(overrides: Partial<DeleteInput> = {}): DeleteInput {
  return { chat: USER, ids: [1], ...overrides }
}

/** Upserts a chat and follows it, so that its messages are stored. */
export function followChat(t: TestMirror, overrides: Partial<ChatInput> = {}): ChatInput {
  const chat = chatInput(overrides)
  upsertChats(t.mirror, [chat], NOW)
  setFollowed(t.mirror, chat.id, true)
  return chat
}

/** The error a function throws, for a test that checks it; fails when it returns. */
export function errorOf(fn: () => unknown): Error {
  try {
    fn()
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error("expected the function to throw")
}

/** The rows of a query, for a test to check. */
export function rowsOf(mirror: Mirror, sql: string, ...params: (string | number | null)[]): Record<string, unknown>[] {
  return mirror.prepare(sql).all(...params) as Record<string, unknown>[]
}

/** The first column of every row of a query. */
export function columnOf(mirror: Mirror, sql: string, ...params: (string | number | null)[]): unknown[] {
  return rowsOf(mirror, sql, ...params).map((row) => Object.values(row)[0])
}

/** The stored message `id` of `chat`, or undefined. */
export function messageRow(mirror: Mirror, chat: string, id: number): Record<string, unknown> | undefined {
  return rowsOf(mirror, "SELECT * FROM messages WHERE chat = ? AND id = ?", chat, id)[0]
}

/** The stored chat, or undefined. */
export function chatRow(mirror: Mirror, id: string): Record<string, unknown> | undefined {
  return rowsOf(mirror, "SELECT * FROM chats WHERE id = ?", id)[0]
}
