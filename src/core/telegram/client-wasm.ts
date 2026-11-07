import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { SIMD_AVAILABLE } from "@mtcute/wasm"

/**
 * The WebAssembly module mtcute's crypto needs (the SIMD build when the
 * runtime supports it). This module reads it from the installed
 * `@mtcute/wasm` package; the bundles replace the whole module with one that
 * embeds the bytes (`scripts/bundle-options.mjs`), because they ship without
 * `node_modules`; keep that replacement's export in step with this one.
 */
export function mtcuteWasmBytes(): Uint8Array {
  const file = SIMD_AVAILABLE ? "mtcute-simd.wasm" : "mtcute.wasm"
  return readFileSync(createRequire(import.meta.url).resolve(`@mtcute/wasm/${file}`))
}
