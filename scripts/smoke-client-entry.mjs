import { join } from "node:path"
import { createTelegramClient } from "../src/core/telegram/client"
import { WasmCryptoProvider } from "../src/core/telegram/client-parts"

const AES_BLOCK = 16
const KEY = Uint8Array.from({ length: 32 }, (_, i) => i)
const IV = Uint8Array.from({ length: 32 }, (_, i) => 255 - i)

const client = createTelegramClient({
  storagePath: join(process.cwd(), "session.db"),
  apiId: 12345,
  apiHash: "0123456789abcdef0123456789abcdef",
  device: { model: "smoke", appVersion: "0.0.0", systemVersion: "smoke" },
  log: (line) => console.error(line),
})

try {
  // Starts the crypto (its WebAssembly) and opens the session file, without connecting.
  await client.prepare()
  // The WebAssembly is module state, so this scheme works only because the client started it.
  const scheme = new WasmCryptoProvider().createAesIge(KEY, IV)
  const plain = Uint8Array.from({ length: AES_BLOCK * 4 }, (_, i) => (i * 3) % 256)
  const encrypted = scheme.encrypt(plain)
  const restored = scheme.decrypt(encrypted)
  if (Buffer.compare(restored, plain) !== 0 || Buffer.compare(encrypted, plain) === 0) {
    throw new Error("AES-IGE did not round-trip")
  }
  console.log("ok")
} finally {
  await client.destroy()
}
