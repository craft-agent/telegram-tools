import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { CHANNEL, GROUP, OTHER_USER, SUPERGROUP, USER } from "../telegram/mirror.testing"
import { createChatFixture, fillSampleChats, type ChatFixture } from "./read.testing"

let t: ChatFixture

beforeEach(() => {
  t = createChatFixture()
})

afterEach(() => {
  t.close()
})

async function ids(args: Record<string, unknown> = {}) {
  return (await t.read({ method: "list", ...args })).chats?.map((chat) => chat.id)
}

describe("chat read: list query", () => {
  test("matches part of a name or a username, ignoring case", async () => {
    fillSampleChats(t)
    expect(await ids({ query: "ali" })).toEqual([USER])
    expect(await ids({ query: "  ALICE " })).toEqual([USER])
    expect(await ids({ query: "team" })).toEqual([GROUP])
    expect(await ids({ query: "example" })).toEqual([USER, OTHER_USER, CHANNEL])
    expect(await ids({ query: "bob_ex" })).toEqual([OTHER_USER])
    expect(await ids({ query: "nobody" })).toEqual([])
  })

  test("a leading @ is ignored, and a username matches with or without it", async () => {
    t.follow({ id: USER, name: "Carol", username: "zed_handle" })
    t.known({ id: OTHER_USER, name: "Dan @home", username: null })
    expect(await ids({ query: "zed_handle" })).toEqual([USER])
    expect(await ids({ query: "@zed_handle" })).toEqual([USER])
    expect(await ids({ query: " @zed" })).toEqual([USER])
    expect(await ids({ query: "@carol" })).toEqual([USER])
    expect(await ids({ query: "@home" })).toEqual([OTHER_USER])
    expect(await ids({ query: "@" })).toEqual(await ids())
  })

  test("a query of blank space filters nothing", async () => {
    fillSampleChats(t)
    expect(await ids({ query: "   " })).toEqual(await ids())
  })

  test("folds non-ASCII case, and an accent written either way", async () => {
    t.known({ id: USER, name: "Ärger Östlich", username: null, lastTs: 2000 })
    t.known({ id: OTHER_USER, name: "Zoë", username: null, lastTs: 1000 })
    for (const query of ["ä", "Ä", "ärger", "ÄRGER", "östl", "ÖSTL"]) expect(await ids({ query })).toEqual([USER])
    for (const query of ["zoë", "ZOË", "zoe\u0308", "ZOE\u0308"]) expect(await ids({ query })).toEqual([OTHER_USER])
  })

  test("ß meets ss, a final ς meets σ, and full-width forms meet their plain letters", async () => {
    t.known({ id: USER, name: "Straße", username: null, lastTs: 3000 })
    t.known({ id: OTHER_USER, name: "ΟΔΟΣ", username: null, lastTs: 2000 })
    t.known({ id: GROUP, kind: "group", name: "ﬁsh ＡＢＣ", username: "ＵＳＥＲ_one", lastTs: 1000 })
    for (const query of ["strasse", "STRASSE", "straße", "ß", "ss"]) expect(await ids({ query })).toEqual([USER])
    for (const query of ["οδος", "οδοσ", "ΟΔΟΣ", "Οδος", "δοσ"]) expect(await ids({ query })).toEqual([OTHER_USER])
    for (const query of ["fish", "FISH", "abc", "ＡＢＣ", "user_one", "@USER"]) {
      expect(await ids({ query })).toEqual([GROUP])
    }
  })

  test("combines with unread, and pages with the filter applied", async () => {
    fillSampleChats(t)
    expect(await ids({ query: "news", unread: true })).toEqual([])
    expect(await ids({ query: "hello", unread: true })).toEqual([])
    expect(await ids({ query: "team", unread: true })).toEqual([GROUP])
    const first = await t.read({ method: "list", query: "e", limit: 1 })
    expect(first.chats?.map((chat) => chat.id)).toEqual([USER])
    const second = await t.read({ method: "list", query: "e", limit: 5, cursor: first.next })
    expect(second.chats?.map((chat) => chat.id)).toEqual([OTHER_USER, GROUP, SUPERGROUP, CHANNEL])
  })

  test("a cursor continues the list it came from, and is refused for a different query or unread", async () => {
    fillSampleChats(t)
    const plain = await t.read({ method: "list", limit: 1 })
    const queried = await t.read({ method: "list", limit: 1, query: "e" })
    const unread = await t.read({ method: "list", limit: 1, unread: true })
    const refused = [
      { query: "e", cursor: plain.next },
      { cursor: queried.next },
      { query: "a", cursor: queried.next },
      { unread: true, cursor: plain.next },
      { cursor: unread.next },
      { unread: true, query: "e", cursor: queried.next },
    ]
    for (const args of refused) {
      const error = await t.failure({ method: "list", ...args })
      expect(error.code).toBe("invalid_argument")
      expect(error.message).toBe("cursor is not a cursor this tool returned.")
    }
    const accepted = [
      { query: "E ", cursor: queried.next },
      { query: "@e", cursor: queried.next },
      { unread: false, cursor: plain.next },
      { last: true, cursor: plain.next },
      { unread: true, cursor: unread.next },
    ]
    for (const args of accepted) expect((await t.read({ method: "list", ...args })).chats).toBeDefined()
  })

  test("the cursor stays short however long the query", async () => {
    const long = "q".repeat(3000)
    t.known({ id: USER, name: `${long}a`, username: null, lastTs: 2000 })
    t.known({ id: OTHER_USER, name: `${long}b`, username: null, lastTs: 1000 })
    const first = await t.read({ method: "list", limit: 1, query: long })
    expect(first.chats?.[0]).toMatchObject({ id: USER, name_cut: true })
    expect(first.next?.length).toBeLessThan(200)
    const second = await t.read({ method: "list", limit: 1, query: long, cursor: first.next })
    expect(second.chats?.map((chat) => chat.id)).toEqual([OTHER_USER])
  })
})
