import { build } from "esbuild"
import { readFileSync } from "node:fs"
import { shared } from "./bundle-options.mjs"

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

await build({
  ...shared,
  entryPoints: ["src/mcp/main.ts"],
  outfile: "dist/mcp.js",
  banner: { js: "#!/usr/bin/env node" },
  define: { __VERSION__: JSON.stringify(version) },
})

await build({
  ...shared,
  entryPoints: ["src/cli/main.ts"],
  outfile: "dist/cli.js",
  banner: { js: "#!/usr/bin/env node" },
})

await build({
  ...shared,
  entryPoints: ["src/opencode/index.ts"],
  outfile: "dist/opencode.js",
})
