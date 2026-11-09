import { describe, expect, test } from "bun:test"
import { plainPathProblem } from "../archive/entry-names"
import { numberedName, safeFileName, unpackedName } from "./names"

const clean = (raw: string | null | undefined, type?: string | null, kind = "photo") =>
  safeFileName(raw, { kind, id: 3, type })

describe("safeFileName", () => {
  test("keeps an ordinary name, in NFC", () => {
    expect(clean("report 2026.pdf")).toBe("report 2026.pdf")
    expect(clean("日本語 ファイル.txt")).toBe("日本語 ファイル.txt")
    expect(clean("cafe\u0301.txt")).toBe("caf\u00e9.txt")
  })

  test("replaces path separators, colons and Windows-unsafe characters with _", () => {
    expect(clean("../../etc/passwd")).toBe("_.._.._etc_passwd")
    expect(clean("a\\b/c:d.txt")).toBe("a_b_c_d.txt")
    expect(clean('q<u>o"t|e?s*.txt')).toBe("q_u_o_t_e_s_.txt")
  })

  test("replaces control and bidi control characters with _, and keeps other invisible ones", () => {
    expect(clean("invoice\u202Etxt.pdf")).toBe("invoice_txt.pdf")
    expect(clean("a\u0007b\nc\u007Fd.txt")).toBe("a_b_c_d.txt")
    expect(clean("a\u200Db.txt")).toBe("a\u200Db.txt")
  })

  test("drops trailing dots and spaces and hides a leading dot", () => {
    expect(clean("name.txt. . ")).toBe("name.txt")
    expect(clean("  spaced.txt  ")).toBe("spaced.txt")
    expect(clean(".bashrc")).toBe("_.bashrc")
    expect(clean("..hidden")).toBe("_..hidden")
  })

  test.each(["CON", "con.txt", "Prn.tar.gz", "AUX", "NUL.log", "COM1", "lpt9.txt", "COM\u00b9.txt", "CON .txt"])(
    "prefixes the Windows device name %s with _",
    (name) => {
      expect(clean(name)).toBe(`_${name}`)
      expect(plainPathProblem(clean(name), false)).toBeUndefined()
    },
  )

  test("gives a file with no name, or none left, <kind>-<id> and an extension for its declared type", () => {
    expect(clean(undefined, "image/jpeg")).toBe("photo-3.jpg")
    expect(clean(null, "image/png")).toBe("photo-3.png")
    expect(clean("", "image/webp; charset=binary")).toBe("photo-3.webp")
    expect(clean("   ", "audio/mpeg", "audio")).toBe("audio-3.mp3")
    expect(clean("...", "video/mp4", "video")).toBe("video-3.mp4")
    expect(clean(undefined, "audio/ogg", "voice")).toBe("voice-3.ogg")
  })

  test("takes no extension from anything but the small map of declared types", () => {
    expect(clean(undefined, "application/x-unknown")).toBe("photo-3")
    expect(clean(undefined, "text/plain")).toBe("photo-3")
    expect(clean(undefined, null)).toBe("photo-3")
    expect(clean(undefined)).toBe("photo-3")
  })

  test("names a nameless file after its kind only when the kind is a plain word", () => {
    expect(clean(undefined, undefined, "../../x")).toBe("file-3")
    expect(clean(undefined, undefined, "")).toBe("file-3")
    expect(clean(undefined, undefined, "Photo")).toBe("file-3")
  })

  test("cuts a long name to 255 bytes of UTF-8, keeping the extension and whole characters", () => {
    const long = clean(`${"あ".repeat(200)}.jpeg`)
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(255)
    expect(long.endsWith(".jpeg")).toBe(true)
    expect(long).not.toContain("\uFFFD")
    expect(clean(`${"a".repeat(300)}.txt`)).toBe(`${"a".repeat(251)}.txt`)
    expect(clean("b".repeat(300))).toBe("b".repeat(255))
  })

  test("always gives a name the archive rules accept as a path component", () => {
    for (const raw of ["CON", "a:b", "x.", " ", "\u0000", "/", "..", "a\u202Eb", "COM1.txt", "ok"]) {
      const name = clean(raw)
      expect(plainPathProblem(name, false)).toBeUndefined()
    }
  })
})

describe("numbering", () => {
  test("puts the number before the extension and keeps the name within 255 bytes", () => {
    expect(numberedName("photo.jpg", 2)).toBe("photo (2).jpg")
    expect(numberedName("notes", 3)).toBe("notes (3)")
    const long = numberedName(`${"a".repeat(251)}.txt`, 12)
    expect(Buffer.byteLength(long)).toBe(255)
    expect(long.endsWith(" (12).txt")).toBe(true)
  })

  test("names the folder an archive is unpacked into, within 255 bytes", () => {
    expect(unpackedName("data.zip")).toBe("data.zip.unpacked")
    expect(unpackedName("data.zip", 2)).toBe("data.zip (2).unpacked")
    expect(Buffer.byteLength(unpackedName(`${"z".repeat(251)}.zip`))).toBeLessThanOrEqual(255)
  })
})
