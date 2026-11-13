import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { excludingContext } from "../chat/excluded.testing"
import { labelPaths } from "../telegram/labels"
import { openMirrorForWrite, setMeta } from "../telegram/mirror"
import { META } from "../telegram/mirror-meta"
import { NOW, makeTempDir } from "../telegram/mirror.testing"
import { invoke } from "../tool"
import { telegramAccountRead } from "./read"

const KEPT = "100"
const FOLLOWED_EXCLUDED = "200"
const UNFOLLOWED_EXCLUDED = "300"

let stateDir: string

beforeEach(() => {
  stateDir = makeTempDir()
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

/** A label whose mirror holds a followed chat and two excluded ones, with messages in each. */
function fillLabel(name: string) {
  const paths = labelPaths(stateDir, name)
  mkdirSync(paths.dir, { recursive: true })
  writeFileSync(paths.session, "")
  const mirror = openMirrorForWrite(paths.mirror)
  try {
    setMeta(mirror, { [META.status]: "stopped", [META.lastReceivedAt]: NOW, [META.refreshedAt]: NOW })
    const chat = mirror.prepare("INSERT INTO chats (id, kind, updated, followed) VALUES (?, 'user', ?, ?)")
    chat.run(KEPT, NOW, 1)
    chat.run(FOLLOWED_EXCLUDED, NOW, 1)
    chat.run(UNFOLLOWED_EXCLUDED, NOW, 0)
    const message = mirror.prepare("INSERT INTO messages (chat, id, ts, received) VALUES (?, ?, ?, ?)")
    for (const [chatId, id] of [
      [KEPT, 1],
      [FOLLOWED_EXCLUDED, 1],
      [FOLLOWED_EXCLUDED, 2],
      [UNFOLLOWED_EXCLUDED, 1],
    ] as const) {
      message.run(chatId, id, NOW, NOW)
    }
  } finally {
    mirror.close()
  }
}

const readWithout = (excluded: string[]) => invoke(telegramAccountRead, {}, excludingContext(stateDir, excluded))

describe("account read: excluded chats", () => {
  test("the counts of chats, followed chats and messages leave excluded chats out, in every label", async () => {
    fillLabel("alpha")
    fillLabel("beta")
    const { accounts } = await readWithout([FOLLOWED_EXCLUDED, UNFOLLOWED_EXCLUDED])
    expect(accounts.map((account) => [account.chats, account.followed, account.messages])).toEqual([
      [1, 1, 1],
      [1, 1, 1],
    ])
  })

  test("only the excluded chats are left out", async () => {
    fillLabel("alpha")
    const [account] = (await readWithout([FOLLOWED_EXCLUDED])).accounts
    expect([account?.chats, account?.followed, account?.messages]).toEqual([2, 1, 2])
  })

  test("the activity times and the service state are as they were", async () => {
    fillLabel("alpha")
    const [open] = (await readWithout([])).accounts
    const [closed] = (await readWithout([KEPT, FOLLOWED_EXCLUDED, UNFOLLOWED_EXCLUDED])).accounts
    expect(closed).toMatchObject({
      chats: 0,
      followed: 0,
      messages: 0,
      service: open?.service,
      last_received_at: open?.last_received_at,
      refreshed_at: open?.refreshed_at,
    })
    expect(open).toMatchObject({ chats: 3, followed: 2, messages: 4 })
  })

  test("a malformed setting fails the read instead of being counted as an unreadable mirror", async () => {
    fillLabel("alpha")
    await expect(readWithout(["not a chat id"])).rejects.toMatchObject({ code: "invalid_argument" })
  })
})
