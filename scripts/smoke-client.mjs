import { build } from "esbuild"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { shared } from "./bundle-options.mjs"

const ENTRY = fileURLToPath(new URL("./smoke-client-entry.mjs", import.meta.url))
const NOT_BUNDLED = "better-sqlite3"

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * Bundles the client with the shipped bundles' options into an empty temp
 * directory, which has no `node_modules` above it, and runs it there under
 * Node: it must start its crypto from the embedded WebAssembly and open its
 * session without the native module `@mtcute/node` would load. Nothing from
 * this bundle ships.
 */
async function startsWithoutNodeModules() {
  const dir = mkdtempSync(join(tmpdir(), "telegram-tools-smoke-"))
  try {
    const bundle = join(dir, "client.mjs")
    await build({ ...shared, logLevel: "silent", entryPoints: [ENTRY], outfile: bundle })
    expect(
      !readFileSync(bundle, "utf8").includes(NOT_BUNDLED),
      `Expected the client bundle not to reach ${NOT_BUNDLED}`,
    )
    const run = spawnSync(process.execPath, [bundle], { cwd: dir, encoding: "utf8", stdio: "pipe" })
    expect(
      run.status === 0 && run.stdout.trim() === "ok",
      `Expected the client bundle to print ok, got ${run.status}: ${run.stdout}${run.stderr}`,
    )
    console.log(
      `The client starts its crypto and opens its session from a bare directory (bundle ${statSync(bundle).size} bytes).`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

try {
  await startsWithoutNodeModules()
} catch (error) {
  console.error(error)
  process.exit(1)
}
