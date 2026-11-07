import { networkMiddlewares } from "@mtcute/core"
import { TelegramClient } from "@mtcute/core/client.js"
import { WasmCryptoProvider, TcpTransport, createPlatform } from "./client-parts"
import { TelegramStorage } from "./storage"

/** What the client says about itself to Telegram, shown among the account's devices. */
export type DeviceInfo = { model: string; appVersion: string; systemVersion: string }

/** What `createTelegramClient` takes. */
export type TelegramClientSettings = {
  /** The session's SQLite file, created when the client first starts. */
  storagePath: string
  /** The app's credentials from my.telegram.org. */
  apiId: number
  apiHash: string
  device: DeviceInfo
  /** Gets one line per warning or error mtcute logs, phone-number-like text masked. */
  log: (line: string) => void
}

/** The language Telegram is told the client speaks. */
const LANGUAGE_CODE = "en"

/**
 * An mtcute client built from our own parts, never `@mtcute/node`'s index:
 * the session on `node:sqlite`, TCP, the crypto with its WebAssembly
 * embedded, and a platform that routes mtcute's log to `log`. It does not
 * connect until it is used. Updates missed while the client was down are
 * caught up. A flood wait is never slept through: the request fails with it
 * (a call may still pass `floodSleepThreshold`), while internal server errors
 * are retried as mtcute does by default.
 */
export function createTelegramClient(settings: TelegramClientSettings): TelegramClient {
  const { storagePath, apiId, apiHash, device, log } = settings
  return new TelegramClient({
    apiId,
    apiHash,
    storage: new TelegramStorage(storagePath),
    crypto: new WasmCryptoProvider(),
    transport: new TcpTransport(),
    platform: createPlatform(log),
    initConnectionOptions: {
      deviceModel: device.model,
      appVersion: device.appVersion,
      systemVersion: device.systemVersion,
      langCode: LANGUAGE_CODE,
      systemLangCode: LANGUAGE_CODE,
    },
    updates: { catchUp: true },
    network: { middlewares: networkMiddlewares.basic({ floodWaiter: { maxWait: 0 } }) },
  })
}
