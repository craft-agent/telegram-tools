import { createServer, type Server } from "node:net"
import type { z } from "zod"
import { createChatFixture, type ChatFixture } from "../chat/read.testing"
import { ToolError } from "../errors"
import { labelPaths } from "../telegram/labels"
import type { ChatInput } from "../telegram/mirror-input"
import { listChat, markSeeded } from "../telegram/sync-list"
import { invoke, type ToolSpec } from "../tool"

/** More made-up supergroups, beside `SUPERGROUP` of the mirror fixtures. */
export const SUPERGROUP_B = "-1001000000003"

/** A chat fixture that runs the sync tools, and puts chats on the sync list the way the service would. */
export type SyncFixture = ChatFixture & {
  /** Calls `tool` with `args` as an entry point would. */
  run<I extends z.ZodObject<z.ZodRawShape>, O extends z.ZodObject<z.ZodRawShape>>(
    tool: ToolSpec<I, O>,
    args: unknown,
  ): Promise<z.output<O>>
  /** The error a call of `tool` throws. */
  fail(tool: ToolSpec, args: unknown): Promise<ToolError>
  /** Upserts a chat, puts it on the sync list at `added`, and records `seeded` (null: not seeded yet). */
  listed(chat: Partial<ChatInput>, added: number, seeded?: number | null): void
  /** Serves the label's socket, but drops every connection after reading its request, as a service that dies mid-call does. */
  serveLost(): Promise<void>
}

/** A state directory with one logged-in label `default`, an empty mirror and a way to run the sync tools. */
export function createSyncFixture(): SyncFixture {
  const chats = createChatFixture()
  const socket = labelPaths(chats.stateDir, "default").socket
  const droppers: Server[] = []
  const run: SyncFixture["run"] = (tool, args) => invoke(tool, args, { cwd: chats.stateDir, stateDir: chats.stateDir })
  return {
    ...chats,
    run,
    async fail(tool, args) {
      try {
        await run(tool, args)
      } catch (error) {
        if (error instanceof ToolError) return error
        throw error
      }
      throw new Error("Expected the call to fail")
    },
    listed(chat, added, seeded = null) {
      const input = chats.known({ kind: "supergroup", name: "Old Friends", username: null, ...chat })
      listChat(chats.mirror, input.id, added)
      if (seeded !== null) markSeeded(chats.mirror, input.id, seeded)
    },
    async serveLost() {
      const server = createServer((connection) => {
        connection.on("data", () => connection.destroy())
        connection.on("error", () => {})
      })
      await new Promise<void>((resolve) => server.listen(socket, resolve))
      droppers.push(server)
    },
    async stopServices() {
      await chats.stopServices()
      await Promise.all(droppers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
    },
  }
}
