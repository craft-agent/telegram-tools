import { dirname } from "node:path"

/** The source module that reads mtcute's WebAssembly from `node_modules`, which the bundles replace. */
const WASM_SOURCE = /src[\\/]core[\\/]telegram[\\/]client-wasm\.ts$/

/** The replacement: the same export, with both builds of the WebAssembly embedded as bytes (esbuild's `binary` loader). */
const WASM_EMBEDDED = `
import { SIMD_AVAILABLE } from "@mtcute/wasm"
import simd from "@mtcute/wasm/mtcute-simd.wasm"
import plain from "@mtcute/wasm/mtcute.wasm"

export function mtcuteWasmBytes() {
  return SIMD_AVAILABLE ? simd : plain
}
`

/** Swaps `client-wasm.ts` for the embedded bytes, so a bundle needs no `node_modules` at run time. */
const embedMtcuteWasm = {
  name: "embed-mtcute-wasm",
  setup(build) {
    build.onLoad({ filter: WASM_SOURCE }, (args) => ({
      contents: WASM_EMBEDDED,
      loader: "ts",
      resolveDir: dirname(args.path),
    }))
  },
}

/** The esbuild options every bundle shares, the shipped ones and the one the smoke check builds. */
export const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  logLevel: "info",
  loader: { ".wasm": "binary" },
  plugins: [embedMtcuteWasm],
}
