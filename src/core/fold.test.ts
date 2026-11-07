import { describe, expect, test } from "bun:test"
import { foldCase } from "./fold"

describe("foldCase", () => {
  test("folds ASCII and non-ASCII letters to one case", () => {
    expect(foldCase("ABC")).toBe("abc")
    expect(foldCase("ÄBC")).toBe("äbc")
    expect(foldCase("ÄBC")).toBe(foldCase("äbc"))
  })

  test("meets ß with ss", () => {
    expect(foldCase("Straße")).toBe(foldCase("STRASSE"))
  })

  test("unifies compatibility forms", () => {
    expect(foldCase("ＡＢＣ")).toBe("abc")
    expect(foldCase("ﬁle")).toBe("file")
  })

  test("unifies composed and decomposed accents", () => {
    expect(foldCase("e\u0301")).toBe(foldCase("\u00e9"))
  })

  test("meets a word-final sigma with a sigma anywhere", () => {
    expect(foldCase("ΟΔΟΣ")).toBe(foldCase("οδοσ"))
    expect(foldCase("οδός")).toBe(foldCase("ΟΔΌΣ"))
    expect(foldCase("ς")).toBe("σ")
  })

  test("leaves text without case alone", () => {
    expect(foldCase("")).toBe("")
    expect(foldCase("123 !?")).toBe("123 !?")
  })
})
