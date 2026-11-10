import { closeSync, ftruncateSync, linkSync, mkdirSync, openSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { failureOf } from "./service.testing"
import { SEND_FILES_MAX_BYTES, type SendFile } from "./service-requests"
import { KEPT } from "./sync-requests.testing"
import {
  FILE_A,
  FILE_B,
  answerFiles,
  fileCallsOf,
  outboxFile,
  sendFiles,
  writeOutboxFile,
} from "./sync-send-files.testing"
import { LEFT_GROUP, MUTED_CHAT, seedSendChats } from "./sync-send.testing"
import { syncFixture, type SyncFixture } from "./sync.testing"

let fixture: SyncFixture

beforeEach(async () => {
  fixture = syncFixture()
  seedSendChats(fixture)
  await fixture.running()
  answerFiles(fixture, { firstId: 50 })
})

afterEach(() => fixture.close())

const refusal = (params: Record<string, unknown>) => failureOf(sendFiles(fixture, params))

/** Whether the service touched Telegram at all for the send: it must not for a file it refuses. */
const touchedTelegram = () =>
  fixture.client.uploads.length + fileCallsOf(fixture).length + fixture.client.argsOf("resolvePeer").length > 0

/** A file of the made-up state directory that is outside the label's outbox. */
function outsideFile(name = "outside.txt"): string {
  const dir = join(fixture.stateDir, "elsewhere")
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, "made-up bytes")
  return path
}

/** A sparse file of `size` bytes in the outbox, which takes no room on disk. */
function sparseOutboxFile(name: string, size: number): SendFile {
  const path = writeOutboxFile(fixture, name, "")
  const fd = openSync(path, "r+")
  try {
    ftruncateSync(fd, size)
  } finally {
    closeSync(fd)
  }
  return { path, name }
}

describe("a file that is not a file in the outbox", () => {
  const notInOutbox = (name: string) => ({
    code: "invalid_argument",
    message: `${name} is not a file in the outbox; nothing was sent.`,
  })

  test("outside it is refused", async () => {
    const file = { path: outsideFile(), name: "outside.txt" }

    expect(await refusal({ chat: KEPT, files: [file] })).toMatchObject(notInOutbox("outside.txt"))
    expect(touchedTelegram()).toBe(false)
  })

  test("a link in the outbox is refused, whether it leads outside or to another file in it", async () => {
    const target = outboxFile(fixture, FILE_A)
    const links = [
      { path: join(fixture.paths.outbox, "to-outside"), target: outsideFile() },
      { path: join(fixture.paths.outbox, "to-inside"), target: target.path },
    ]
    for (const { path, target } of links) symlinkSync(target, path)

    for (const link of links) {
      expect(await refusal({ chat: KEPT, files: [{ path: link.path, name: "link.txt" }] })).toMatchObject(
        notInOutbox("link.txt"),
      )
    }
    expect(touchedTelegram()).toBe(false)
  })

  test("a file behind a linked directory that leads outside is refused", async () => {
    outsideFile("inner.txt")
    mkdirSync(fixture.paths.outbox, { recursive: true })
    symlinkSync(join(fixture.stateDir, "elsewhere"), join(fixture.paths.outbox, "folder"))

    const file = { path: join(fixture.paths.outbox, "folder", "inner.txt"), name: "inner.txt" }

    expect(await refusal({ chat: KEPT, files: [file] })).toMatchObject(notInOutbox("inner.txt"))
    expect(touchedTelegram()).toBe(false)
  })

  test("a file that is missing, a directory, and the outbox itself are refused", async () => {
    mkdirSync(join(fixture.paths.outbox, "folder"), { recursive: true })
    const paths = [
      join(fixture.paths.outbox, "missing.txt"),
      join(fixture.paths.outbox, "folder"),
      fixture.paths.outbox,
    ]

    for (const path of paths) {
      expect(await refusal({ chat: KEPT, files: [{ path, name: "x.txt" }] })).toMatchObject(notInOutbox("x.txt"))
    }
    expect(touchedTelegram()).toBe(false)
  })

  test("is refused when the outbox does not exist", async () => {
    const files = [{ path: join(fixture.paths.outbox, "a.txt"), name: "a.txt" }]

    expect(await refusal({ chat: KEPT, files })).toMatchObject(notInOutbox("a.txt"))
  })

  test("a bad file among good ones sends none of them", async () => {
    const good = outboxFile(fixture, FILE_A)
    const files = [good, { path: join(fixture.paths.outbox, "missing.txt"), name: "missing.txt" }]

    expect(await refusal({ chat: KEPT, files })).toMatchObject(notInOutbox("missing.txt"))
    expect(touchedTelegram()).toBe(false)
  })
})

describe("files that cannot be sent together", () => {
  test("an empty file is refused", async () => {
    const empty = { path: writeOutboxFile(fixture, "empty.txt", ""), name: "empty.txt" }

    expect(await refusal({ chat: KEPT, files: [empty] })).toMatchObject({
      code: "invalid_argument",
      message: "empty.txt is empty; nothing was sent.",
    })
    expect(touchedTelegram()).toBe(false)
  })

  test("the same file under two paths is refused", async () => {
    const first = outboxFile(fixture, FILE_A)
    const path = join(fixture.paths.outbox, "again.txt")
    linkSync(first.path, path)

    expect(await refusal({ chat: KEPT, files: [first, { path, name: "again.txt" }] })).toMatchObject({
      code: "invalid_argument",
      message: "again.txt is the same file as another one; nothing was sent.",
    })
    expect(touchedTelegram()).toBe(false)
  })

  test("files over the most bytes together are refused, though each is within it", async () => {
    const half = SEND_FILES_MAX_BYTES / 2
    const files = [sparseOutboxFile("one.bin", half), sparseOutboxFile("two.bin", half + 1)]

    expect(await refusal({ chat: KEPT, files })).toMatchObject({
      code: "invalid_argument",
      message: "The files are over 100 MB together; nothing was sent.",
    })
    expect(touchedTelegram()).toBe(false)
  })
})

describe("a chat the mirror shows cannot take the send", () => {
  test("one the account left is forbidden, and one it cannot write in too, with nothing touched", async () => {
    const file = outboxFile(fixture, FILE_B)

    for (const chat of [LEFT_GROUP, MUTED_CHAT]) {
      expect(await refusal({ chat, files: [file] })).toMatchObject({ code: "forbidden" })
    }
    expect(touchedTelegram()).toBe(false)
  })

  test("one the mirror does not list is not_found, and a reply to a message it lacks too", async () => {
    const file = outboxFile(fixture, FILE_B)

    expect(await refusal({ chat: "-1007200000099", files: [file] })).toMatchObject({ code: "not_found" })
    expect(await refusal({ chat: KEPT, files: [file], reply_to: 99 })).toMatchObject({ code: "not_found" })
    expect(touchedTelegram()).toBe(false)
  })
})
