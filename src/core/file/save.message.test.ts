import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { ELF_BYTES } from "../archive/archive.testing"
import { PRIVATE_NOTE } from "../chat/message-schema"
import { ToolError } from "../errors"
import { NOW } from "../telegram/mirror.testing"
import { formatLocalTime } from "../time"
import { abortWhen } from "./abort.testing"
import { createSaveFixture, saveArgs, type SaveFixture } from "./save.testing"

let t: SaveFixture

beforeEach(() => {
  t = createSaveFixture()
})
afterEach(() => t.close())

describe("a disappearing message's file", () => {
  test("is saved with the note that it is for the user only, and when the message disappears", async () => {
    await t.serveFile("secret", { disappears_at: NOW + 60_000 })
    const result = await t.save(saveArgs())
    expect(result.files).toHaveLength(1)
    expect(result.private_note).toBe(PRIVATE_NOTE)
    expect(result.disappears_at).toBe(formatLocalTime(NOW + 60_000))
  })

  test("is noted when it is refused too, since its name is the user's alone", async () => {
    await t.serveFile(ELF_BYTES, { name: "x.pdf", disappears_at: NOW + 60_000 })
    const result = await t.save(saveArgs())
    expect(result.refused).toHaveLength(1)
    expect(result.private_note).toBe(PRIVATE_NOTE)
  })

  test("a message that does not disappear carries neither", async () => {
    await t.serveFile("plain")
    const result = await t.save(saveArgs())
    expect(result).not.toHaveProperty("private_note")
    expect(result).not.toHaveProperty("disappears_at")
  })
})

describe("what the service answers with an error", () => {
  test.each([
    ["not_found", "No message 42 in this chat."],
    ["forbidden", "This file was meant to be seen once; it is not saved."],
    ["rate_limited", "Telegram asks to wait 30 seconds."],
    ["upstream_error", "The download received nothing for 60 seconds; try again later."],
  ] as const)("%s passes through with its message, and nothing is saved", async (code, message) => {
    await t.serve(() => {
      throw new ToolError(code, message)
    })
    const error = await t.failure(saveArgs())
    expect(error).toMatchObject({ code, message })
    expect(readdirSync(t.downloadDir)).toEqual([])
  })

  test("a service that is not running is the client's error, with nothing made", async () => {
    const error = await t.failure(saveArgs())
    expect(error.code).toBe("upstream_error")
    expect(error.message).toContain("sync service is not running")
    expect(readdirSync(t.downloadDir)).toEqual([])
  })
})

describe("a cancellation", () => {
  test("while the service downloads is an AbortError, since a download changes nothing at Telegram", async () => {
    const controller = new AbortController()
    await t.serve(() => {
      queueMicrotask(() => controller.abort())
      return new Promise<never>(() => {})
    })
    await expect(t.save(saveArgs(), { ctx: { signal: controller.signal } })).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(readdirSync(t.downloadDir)).toEqual([])
  })

  test("before the file is checked leaves nothing, and the folder the service made is removed", async () => {
    await t.serveFile("data")
    const signal = abortWhen(() => true)
    await expect(t.save(saveArgs(), { ctx: { signal } })).rejects.toMatchObject({ name: "AbortError" })
    expect(readdirSync(t.downloadDir)).toEqual([])
    expect(t.incomingNames()).toEqual([])
  })

  test("while the file is copied removes the partial copy with the folder, and makes no folder", async () => {
    await t.serveFile("data")
    let checks = 0
    const signal = abortWhen(() => ++checks > 1)
    await expect(t.save(saveArgs(), { ctx: { signal } })).rejects.toMatchObject({ name: "AbortError" })
    expect(checks).toBeGreaterThan(1)
    expect(readdirSync(t.downloadDir)).toEqual([])
    expect(t.incomingNames()).toEqual([])
  })

  test("that is already in effect throws before the service is asked", async () => {
    const calls = await t.serveFile("data")
    const controller = new AbortController()
    controller.abort()
    await expect(t.save(saveArgs(), { ctx: { signal: controller.signal } })).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(calls).toEqual([])
  })
})
