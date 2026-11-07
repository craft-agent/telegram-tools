import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TelegramClient } from "@mtcute/core/client.js"
import { LogManager } from "@mtcute/core/utils.js"
import { createTelegramClient, type DeviceInfo } from "./client"
import { WasmCryptoProvider, createPlatform } from "./client-parts"
import type { LoginClient } from "./login"

const OWNER_ONLY = 0o600
const API_ID = 12345
const API_HASH = "0123456789abcdef0123456789abcdef"
const DEVICE: DeviceInfo = { model: "Test Device", appVersion: "1.2.3", systemVersion: "Test OS 9" }
const SHA256_OF_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
const IGE_KEY = Uint8Array.from({ length: 32 }, (_, i) => i)
const IGE_IV = Uint8Array.from({ length: 32 }, (_, i) => 255 - i)
const IGE_BLOCKS = 4
const AES_BLOCK = 16

let dir: string
let storagePath: string
let lines: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "telegram-client-"))
  storagePath = join(dir, "session.db")
  lines = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function build(): TelegramClient {
  return createTelegramClient({
    storagePath,
    apiId: API_ID,
    apiHash: API_HASH,
    device: DEVICE,
    log: (line) => lines.push(line),
  })
}

/** What the client will send Telegram in `initConnection`, which mtcute keeps on its network manager. */
function initConnectionOf(client: TelegramClient): Record<string, unknown> {
  const { _client } = client as unknown as {
    _client: { mt: { network: { _initConnectionParams: Record<string, unknown> } } }
  }
  return _client.mt.network._initConnectionParams
}

describe("the crypto", () => {
  test("starts from the embedded WebAssembly and encrypts and decrypts with AES-IGE", async () => {
    const crypto = new WasmCryptoProvider()
    await crypto.initialize()
    const plain = Uint8Array.from({ length: AES_BLOCK * IGE_BLOCKS }, (_, i) => (i * 3) % 256)
    const scheme = crypto.createAesIge(IGE_KEY, IGE_IV)
    const encrypted = scheme.encrypt(plain)
    expect(encrypted).toHaveLength(plain.length)
    expect(encrypted).not.toEqual(plain)
    expect(scheme.decrypt(encrypted)).toEqual(plain)
  })

  test("hashes with SHA-256", async () => {
    const crypto = new WasmCryptoProvider()
    await crypto.initialize()
    expect(Buffer.from(crypto.sha256(new TextEncoder().encode("abc"))).toString("hex")).toBe(SHA256_OF_ABC)
  })

  test("can start twice", async () => {
    await new WasmCryptoProvider().initialize()
    await new WasmCryptoProvider().initialize()
  })
})

describe("createTelegramClient", () => {
  test("builds a client that fits the login flows, without opening the session or connecting", () => {
    const client = build()
    const asLoginClient: LoginClient = client
    expect(asLoginClient).toBe(client)
    expect(existsSync(storagePath)).toBe(false)
  })

  test("keeps its session in the given file, readable by its owner only", async () => {
    const client = build()
    await client.prepare()
    try {
      expect(statSync(storagePath).mode & 0o777).toBe(OWNER_ONLY)
    } finally {
      await client.destroy()
    }
  })

  test("tells Telegram the given device and the app's id", () => {
    expect(initConnectionOf(build())).toMatchObject({
      apiId: API_ID,
      deviceModel: DEVICE.model,
      appVersion: DEVICE.appVersion,
      systemVersion: DEVICE.systemVersion,
      langCode: "en",
      systemLangCode: "en",
    })
  })

  test("does not load better-sqlite3", () => {
    build()
    expect(Object.keys(require.cache).filter((name) => name.includes("better-sqlite3"))).toEqual([])
  })
})

describe("the platform's log", () => {
  const platform = () => createPlatform((line) => lines.push(line))

  test("drops debug, info and verbose output", () => {
    for (const level of [LogManager.INFO, LogManager.DEBUG, LogManager.VERBOSE]) {
      platform().log(0, level, "tag", "message %s", ["x"])
    }
    expect(lines).toEqual([])
  })

  test("passes on warnings and errors as lines with the level and the tag", () => {
    platform().log(0, LogManager.WARN, "network", "slow %s after %d ms", ["reply", 40])
    platform().log(0, LogManager.ERROR, "storage", "cannot write", [])
    expect(lines).toEqual(["warning [network] slow reply after 40 ms", "error [storage] cannot write"])
  })

  test("masks phone-number-like text, in the message and in its arguments", () => {
    platform().log(0, LogManager.ERROR, "auth", "failed for +1 555 010 0199 (%s)", ["+15550100199"])
    expect(lines).toEqual(["error [auth] failed for [number] ([number])"])
  })

  test("leaves mtcute's own level at its default, and names the device", () => {
    const { getDefaultLogLevel, getDeviceModel } = platform()
    expect(getDefaultLogLevel()).toBeNull()
    expect(getDeviceModel()).toContain("Node.js/")
  })

  test("takes the client's own log output at warning level only", async () => {
    const client = build()
    client.log.debug("debug %s", "x")
    client.log.info("info %s", "x")
    client.log.warn("warn for %s", "+15550100199")
    expect(lines).toEqual(["warning [client] warn for [number]"])
    await client.destroy()
  })
})
