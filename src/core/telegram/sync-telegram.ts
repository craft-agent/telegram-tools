import type { TelegramClient } from "@mtcute/core/client.js"
import type { AppCredentials } from "./app"
import type { FreezableStorage } from "./client"

/**
 * The part of mtcute's client the sync service uses, so a fake can stand in
 * for it. The service never builds its client: it is handed `OpenClient`.
 */
export type SyncTelegram = Pick<
  TelegramClient,
  | "connect"
  | "getMe"
  | "startUpdatesLoop"
  | "destroy"
  | "iterDialogs"
  | "getHistory"
  | "searchMessages"
  | "getForumTopics"
  | "getMessages"
  | "downloadAsIterable"
  | "resolvePeer"
  | "call"
  | "handleClientUpdate"
  | "onNewMessage"
  | "onEditMessage"
  | "onDeleteMessage"
  | "onHistoryRead"
  | "onConnectionState"
  | "onError"
> &
  FreezableStorage

/** Builds the client for the label's session with the app's credentials; it does not connect until it is used. */
export type OpenClient = (app: AppCredentials) => SyncTelegram
