import { existsSync, statSync } from "node:fs"
import { z } from "zod"
import { ToolError } from "../errors"
import { labelPaths, listLabels, pickLabel, type LabelPaths } from "../telegram/labels"
import { getMeta, MIRROR_VERSION_REFUSALS, openMirrorForRead } from "../telegram/mirror"
import { META, SYNC_STATUS } from "../telegram/mirror-meta"
import { lockHolder } from "../telegram/sync-lock"
import { defineTool } from "../tool"

const input = z.object({
  account: z.string().optional().describe("The account label; absent lists every label."),
})

const account = z.object({
  label: z.string().describe("The label used to select this account."),
  login: z.enum(["logged in", "logged out", "not logged in"]).describe("Whether this account is logged in."),
  service: z
    .enum(["running", "starting", "stopped", "failed", "not running", "never run"])
    .describe("The recorded sync service state, corrected for a service process that is no longer alive."),
  connected_at: z.iso.datetime().nullable().describe("When the service last connected to Telegram, in UTC."),
  last_received_at: z.iso.datetime().nullable().describe("When a message was last received, in UTC."),
  refreshed_at: z.iso.datetime().nullable().describe("When the chat list was last refreshed, in UTC."),
  chats: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe("The number of chats in the mirror, or null when there is no mirror."),
  followed: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe("The number of followed chats in the mirror, or null when there is no mirror."),
  messages: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe("The number of messages in the mirror, or null when there is no mirror."),
  error: z
    .string()
    .nullable()
    .describe("The recorded service error or mirror-version refusal, without message content or account identifiers."),
  action: z
    .enum(["log_in", "start_service", "check_service"])
    .nullable()
    .describe("The person's next step, or null when none is needed."),
  hint: z.string().nullable().describe("One sentence explaining the person's next step, or null."),
})

type Account = z.infer<typeof account>

const output = z.object({
  accounts: z.array(account).describe("Accounts sorted by label; no phone numbers, account ids or keys."),
})

function timestamp(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null
  const date = new Date(Number(value))
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

const UNREADABLE_MIRROR = "the mirror cannot be read"
const CHECK_SERVICE_HINT = "Check the sync service's status and log to find why it failed."

function isVersionRefusal(error: unknown): error is ToolError {
  return error instanceof ToolError && error.code === "upstream_error" && MIRROR_VERSION_REFUSALS.has(error.message)
}

function nextStep(result: Account, mirrorRefused: boolean): void {
  if (mirrorRefused) {
    result.action = "start_service"
    result.hint =
      "Restart the sync service to bring the mirror up to date; update the tools first if the mirror is newer."
  } else if (result.error === UNREADABLE_MIRROR) {
    result.action = "check_service"
    result.hint = CHECK_SERVICE_HINT
  } else if (result.login === "not logged in") {
    result.action = "log_in"
    result.hint = "Log in to this account."
  } else if (result.login === "logged out") {
    result.action = "log_in"
    result.hint = "Telegram ended this session; log in again."
  } else if (result.service === "failed") {
    result.action = "check_service"
    result.hint = CHECK_SERVICE_HINT
  } else if (result.service !== "running" && result.service !== "starting") {
    result.action = "start_service"
    result.hint = "Start the sync service to receive messages for this account."
  }
}

function readAccount(paths: LabelPaths): Account {
  const sessionExists = existsSync(paths.session)
  const result: Account = {
    label: paths.label,
    login: sessionExists ? "logged in" : "not logged in",
    service: "never run",
    connected_at: null,
    last_received_at: null,
    refreshed_at: null,
    chats: null,
    followed: null,
    messages: null,
    error: null,
    action: null,
    hint: null,
  }
  let mirrorRefused = false
  if (existsSync(paths.mirror)) {
    try {
      const mirror = openMirrorForRead(paths.mirror)
      try {
        const meta = getMeta(mirror)
        const status = meta[META.status]
        if (status === SYNC_STATUS.loggedOut) {
          const startedAt = meta[META.startedAt]
          const sessionMtime = statSync(paths.session, { throwIfNoEntry: false })?.mtimeMs ?? Number.NEGATIVE_INFINITY
          const reloggedIn = sessionExists && startedAt !== undefined && sessionMtime > Number(startedAt)
          result.login = sessionExists ? (reloggedIn ? "logged in" : "logged out") : "not logged in"
          result.service = "stopped"
        } else if (status === SYNC_STATUS.running || status === SYNC_STATUS.starting) {
          const holder = lockHolder(paths.syncLock)
          result.service = holder !== undefined ? status : "not running"
        } else if (status === SYNC_STATUS.failed) {
          result.service = "failed"
        } else if (status === SYNC_STATUS.stopped) {
          result.service = "stopped"
        } else {
          result.service = "never run"
        }
        result.connected_at = timestamp(meta[META.connectedAt])
        result.last_received_at = timestamp(meta[META.lastReceivedAt])
        result.refreshed_at = timestamp(meta[META.refreshedAt])
        result.error = meta[META.error] ?? null

        const chatsRow = mirror.prepare("SELECT count(*) as count FROM chats").get() as { count: number }
        const followedRow = mirror.prepare("SELECT count(*) as count FROM chats WHERE followed = 1").get() as {
          count: number
        }
        const messagesRow = mirror.prepare("SELECT count(*) as count FROM messages").get() as { count: number }
        result.chats = Number(chatsRow?.count ?? 0)
        result.followed = Number(followedRow?.count ?? 0)
        result.messages = Number(messagesRow?.count ?? 0)
      } finally {
        mirror.close()
      }
    } catch (error) {
      if (isVersionRefusal(error)) {
        result.service = "failed"
        result.error = error.message
        mirrorRefused = true
      } else if (error instanceof ToolError && error.code === "not_found") {
        // The mirror has not been initialized yet (user_version = 0).
      } else {
        result.service = "failed"
        result.error = UNREADABLE_MIRROR
        result.connected_at = null
        result.last_received_at = null
        result.refreshed_at = null
        result.chats = null
        result.followed = null
        result.messages = null
      }
    }
  }
  nextStep(result, mirrorRefused)
  return result
}

export const telegramAccountRead = defineTool({
  id: "telegram_account_read",
  title: "Read account status",
  description: [
    "Report account login, sync service health and the person's next step for one label or every label.",
    "Reads local state only, needs no network or daemon, and never writes anything.",
    "Other people's text never appears here; no message content, phone numbers, account ids or keys are returned.",
  ].join(" "),
  toolset: "account",
  class: "read",
  input,
  output,
  async execute(args, ctx) {
    const stateDir = ctx.stateDir
    if (!stateDir) throw new ToolError("internal_error", "The entry point did not supply a state directory.")
    const paths =
      args.account !== undefined
        ? [await pickLabel(stateDir, args.account)]
        : (await listLabels(stateDir)).map((label) => labelPaths(stateDir, label))
    return { accounts: paths.map(readAccount) }
  },
})
