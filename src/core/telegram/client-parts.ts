import { arch, type } from "node:os"
import { version } from "node:process"
import { Readable } from "node:stream"
import { format } from "node:util"
import { connectTcp, nodeReadableToFuman } from "@fuman/node"
import { IntermediatePacketCodec, type ICorePlatform, type TelegramTransport } from "@mtcute/core"
import { LogManager, type BasicDcOption } from "@mtcute/core/utils.js"
import { NodeCryptoProvider } from "@mtcute/node/utils.js"
import { initSync } from "@mtcute/wasm"
import { mtcuteWasmBytes } from "./client-wasm"
import { maskPhoneNumbers } from "./service-errors"

/**
 * `@mtcute/node`'s TCP transport (its index cannot be imported: it loads
 * `better-sqlite3`): MTProto's intermediate codec over a socket with
 * Nagle's algorithm off and keep-alive on.
 */
export class TcpTransport implements TelegramTransport {
  async connect(dc: BasicDcOption, abortSignal: AbortSignal) {
    const connection = await connectTcp({ address: dc.ipAddress, port: dc.port }, abortSignal)
    connection.setNoDelay(true)
    connection.setKeepAlive(true)
    return connection
  }

  packetCodec() {
    return new IntermediatePacketCodec()
  }
}

/**
 * `@mtcute/node`'s crypto on `node:crypto`, with its WebAssembly (AES-IGE and
 * compression) taken from `mtcuteWasmBytes` instead of being looked up in
 * `node_modules` at run time.
 */
export class WasmCryptoProvider extends NodeCryptoProvider {
  async initialize(): Promise<void> {
    initSync(mtcuteWasmBytes())
  }
}

const callbacksBeforeExit = new Set<() => void>()
let exitHooked = false

function runBeforeExitCallbacks(): void {
  for (const callback of [...callbacksBeforeExit]) callback()
  callbacksBeforeExit.clear()
}

/**
 * Runs `fn` once, synchronously, when the process ends on its own or through
 * `process.exit`, so mtcute's storage writes what it still holds and closes its
 * database; returns a function that cancels it. Signals are not hooked: whoever
 * stops the process on SIGINT or SIGTERM destroys the client first.
 */
function beforeExit(fn: () => void): () => void {
  if (!exitHooked) {
    exitHooked = true
    process.on("beforeExit", runBeforeExitCallbacks)
    process.on("exit", runBeforeExitCallbacks)
  }
  callbacksBeforeExit.add(fn)
  return () => {
    callbacksBeforeExit.delete(fn)
  }
}

/** What each of mtcute's log levels that this platform passes on is called in a line. */
const LEVEL_NAMES = { [LogManager.ERROR]: "error", [LogManager.WARN]: "warning" } as const

/**
 * The part of mtcute's platform the client needs: a device model, its log
 * level (left to mtcute's default, warnings and errors), and `log`, which
 * gets one line per warning or error with phone-number-like text masked and
 * nothing of the lower levels. `normalizeFile` takes a Node stream and nothing
 * else (the sender hands the upload an open descriptor's stream, never a path
 * for mtcute to open again); the size comes from the caller.
 */
export function createPlatform(log: (line: string) => void): ICorePlatform {
  return {
    beforeExit,
    normalizeFile: (file) => (file instanceof Readable ? { file: nodeReadableToFuman(file) } : null),
    getDeviceModel: () => `Node.js/${version} (${type()} ${arch()})`,
    getDefaultLogLevel: () => null,
    log: (_color, level, tag, fmt, args) => {
      if (level !== LogManager.ERROR && level !== LogManager.WARN) return
      log(maskPhoneNumbers(`${LEVEL_NAMES[level]} [${tag}] ${format(fmt, ...args)}`))
    },
  }
}
