import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseApiHash, parseApiId, readApp, writeApp } from "./app"
import { errorOf, makeTempDir } from "./mirror.testing"

const HASH = "0123456789abcdef0123456789abcdef"
const OTHER_HASH = "fedcba9876543210fedcba9876543210"

let dir: string
let path: string

beforeEach(() => {
  dir = makeTempDir()
  path = join(dir, "app.json")
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("parseApiId", () => {
  test("accepts a positive whole number, trimmed", () => {
    expect(parseApiId(" 12345 \n")).toBe(12345)
  })

  test.each(["", "0", "-5", "1.5", "1e3", "0x10", "abc", "12 34", "99999999999999999999"])("rejects %j", (text) => {
    const error = errorOf(() => parseApiId(text))
    expect(error).toMatchObject({ code: "invalid_argument" })
    if (text) expect(error.message).not.toContain(text)
  })
})

describe("parseApiHash", () => {
  test("accepts 32 hex characters, trimmed and lowercased", () => {
    expect(parseApiHash(`  ${HASH.toUpperCase()}\n`)).toBe(HASH)
  })

  test.each(["", "abc", `${HASH}0`, HASH.slice(1), `${HASH.slice(1)}g`])("rejects %j", (text) => {
    const error = errorOf(() => parseApiHash(text))
    expect(error).toMatchObject({ code: "invalid_argument" })
    if (text) expect(error.message).not.toContain(text)
  })
})

describe("writeApp and readApp", () => {
  test("round-trips, in the documented shape, at mode 0600", () => {
    writeApp(path, { apiId: 12345, apiHash: HASH.toUpperCase() })

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ api_id: 12345, api_hash: HASH })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readApp(path)).toEqual({ apiId: 12345, apiHash: HASH })
  })

  test("replaces an earlier file, tightens its mode and leaves no temp file", () => {
    writeFileSync(path, "{}", { mode: 0o644 })

    writeApp(path, { apiId: 7, apiHash: OTHER_HASH })

    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readApp(path)).toEqual({ apiId: 7, apiHash: OTHER_HASH })
    expect(readdirSync(dir)).toEqual(["app.json"])
  })

  test.each([
    { apiId: 0, apiHash: HASH },
    { apiId: -1, apiHash: HASH },
    { apiId: 1.5, apiHash: HASH },
    { apiId: Number.MAX_SAFE_INTEGER + 1, apiHash: HASH },
    { apiId: 1, apiHash: "short" },
  ])("refuses %j and writes nothing", (app) => {
    expect(errorOf(() => writeApp(path, app))).toMatchObject({ code: "invalid_argument" })
    expect(readdirSync(dir)).toEqual([])
  })

  test("a missing file is not_found", () => {
    expect(errorOf(() => readApp(path))).toMatchObject({ code: "not_found" })
  })

  test.each([
    "not json",
    "null",
    "[]",
    "{}",
    JSON.stringify({ api_id: "12345", api_hash: HASH }),
    JSON.stringify({ api_id: 0, api_hash: HASH }),
    JSON.stringify({ api_id: 1, api_hash: "xyz" }),
  ])("a malformed file (%s) is upstream_error without its content or path", (content) => {
    writeFileSync(path, content)

    const error = errorOf(() => readApp(path))

    expect(error).toMatchObject({ code: "upstream_error" })
    expect(error.message).not.toContain(path)
    expect(error.message).not.toContain(HASH)
  })

  test("an unreadable path is upstream_error without the path", () => {
    const error = errorOf(() => readApp(dir))

    expect(error).toMatchObject({ code: "upstream_error" })
    expect(error.message).not.toContain(dir)
  })
})
