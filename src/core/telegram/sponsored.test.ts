import { expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const SOURCE_DIR = join(import.meta.dir, "..", "..")

/** Source files other than tests, as paths from the source directory. */
function sourceFiles(): string[] {
  return readdirSync(SOURCE_DIR, { recursive: true, encoding: "utf8" }).filter(
    (path) => path.endsWith(".ts") && !path.endsWith(".test.ts"),
  )
}

/** The code of a file without its comments, which may name sponsored messages to say they are not asked for. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

test("no code path asks Telegram for sponsored messages", () => {
  const files = sourceFiles()
  const mentioning = files.filter((path) =>
    /sponsored/i.test(withoutComments(readFileSync(join(SOURCE_DIR, path), "utf8"))),
  )

  expect(files.length).toBeGreaterThan(50)
  expect(mentioning).toEqual([])
})
