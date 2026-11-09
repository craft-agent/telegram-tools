import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { MESSAGE_ID, createSaveFixture, saveArgs, type SaveFixture } from "./save.testing"

let t: SaveFixture

beforeEach(() => {
  t = createSaveFixture()
})
afterEach(() => t.close())

/** Saves a file the service downloaded with `declared`, and returns the name it was saved under. */
async function savedName(declared: Parameters<SaveFixture["serveFile"]>[1]): Promise<string> {
  await t.serveFile("content", declared)
  return (await t.save(saveArgs())).files[0]!.name
}

describe("the name a file is saved under", () => {
  test("a name that is a path, or full of separators, stays in the message's folder", async () => {
    for (const [name, saved] of [
      ["../../escape.txt", "_.._.._escape.txt"],
      ["/etc/cron.d/job", "_etc_cron.d_job"],
      ["C:\\Windows\\win.ini", "C__Windows_win.ini"],
    ] as const) {
      expect(await savedName({ name })).toBe(saved)
    }
    expect(readdirSync(t.folder).sort()).toEqual(["C__Windows_win.ini", "_.._.._escape.txt", "_etc_cron.d_job"])
  })

  test("control and bidi characters become _, and Windows names and hidden files are fixed", async () => {
    expect(await savedName({ name: "invoice\u202Etxt.pdf" })).toBe("invoice_txt.pdf")
    expect(await savedName({ name: "CON.txt" })).toBe("_CON.txt")
    expect(await savedName({ name: ".env" })).toBe("_.env")
  })

  test("a name over 255 bytes is cut and keeps its extension", async () => {
    const name = await savedName({ name: `${"長い".repeat(100)}.png` })
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255)
    expect(name.endsWith(".png")).toBe(true)
    expect(readdirSync(t.folder)).toEqual([name])
  })

  test("a photo with no name is photo-<message id> with an extension from its declared type", async () => {
    expect(await savedName({ name: null, kind: "photo", type: "image/jpeg" })).toBe(`photo-${MESSAGE_ID}.jpg`)
  })

  test.each([
    ["video", "video/mp4", ".mp4"],
    ["voice", "audio/ogg", ".ogg"],
    ["audio", "audio/mpeg", ".mp3"],
    ["photo", "image/png", ".png"],
    ["sticker", "image/webp", ".webp"],
  ])("a nameless %s of type %s is saved with %s", async (kind, type, extension) => {
    expect(await savedName({ name: null, kind, type })).toBe(`${kind}-${MESSAGE_ID}${extension}`)
  })

  test("a nameless file of a type outside the small map, or of none, has no extension", async () => {
    expect(await savedName({ name: null, kind: "video", type: "video/x-unknown" })).toBe(`video-${MESSAGE_ID}`)
    expect(await savedName({ name: null, kind: "video", type: null })).toBe(`video-${MESSAGE_ID}`)
  })

  test("a name the sender gave that cleans to nothing falls back to the kind", async () => {
    expect(await savedName({ name: "...", kind: "document", type: "image/png" })).toBe(`document-${MESSAGE_ID}.png`)
  })

  test("an extension is never taken from the sender: the declared name is cleaned, not extended", async () => {
    expect(await savedName({ name: "photo", type: "image/png" })).toBe("photo")
  })
})
