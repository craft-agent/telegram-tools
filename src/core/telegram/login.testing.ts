import { SentCode, User, tl } from "@mtcute/core"
import { fakeSelf } from "./fake-telegram.testing"
import type { LoginClient, LoginIo } from "./login"

/** The methods of the fake client; each has its own queue of scripted answers. */
export type FakeLoginMethod = keyof LoginClient

/** One scripted answer: a value to return, an error to throw, or a function that decides from the call's argument. */
export type Scripted<T, A = unknown> = T | Error | ((arg: A) => T | Promise<T>)

/** A recorded call: the method and its argument. */
export type FakeLoginCall = { method: FakeLoginMethod; arg: unknown }

/** The fake client with its scripting and its record. */
export type FakeLoginClient = LoginClient & {
  calls: FakeLoginCall[]
  /** Queues answers for a method; each call takes the next, and a call with none left fails the test. */
  script(method: FakeLoginMethod, ...answers: Scripted<unknown, never>[]): FakeLoginClient
  /** The arguments the method was called with, in order. */
  argsOf(method: FakeLoginMethod): unknown[]
}

/** A Telegram error as mtcute raises it: `new RpcError(code, text)`. */
export function rpcError(code: number, text: string): tl.RpcError {
  return new tl.RpcError(code, text as never)
}

/** A flood wait as mtcute raises it from a server answer. */
export function floodWait(seconds: number): tl.RpcError {
  return tl.RpcError.fromTl({ errorCode: 420, errorMessage: `FLOOD_WAIT_${seconds}` })
}

/** The logged-in account as a made-up mtcute user. */
export function fakeAccount(): User {
  return new User(fakeSelf())
}

/** The answer of a code request for a number that is not logged in yet. */
export function fakeSentCode(phoneCodeHash = "hash-1"): SentCode {
  return new SentCode({
    _: "auth.sentCode",
    type: { _: "auth.sentCodeTypeApp", length: 5 },
    phoneCodeHash,
  })
}

/** A client that answers each call from its method's queue and records the calls. */
export function createFakeLoginClient(): FakeLoginClient {
  const queues = new Map<FakeLoginMethod, Scripted<unknown, never>[]>()
  const calls: FakeLoginCall[] = []

  async function answer(method: FakeLoginMethod, arg: unknown): Promise<unknown> {
    calls.push({ method, arg })
    const queue = queues.get(method)
    if (!queue?.length) throw new Error(`no scripted answer left for ${method}`)
    const next = queue.shift()
    if (next instanceof Error) throw next
    return typeof next === "function" ? (next as (a: unknown) => unknown)(arg) : next
  }

  const client = {
    calls,
    script(method: FakeLoginMethod, ...answers: Scripted<unknown, never>[]) {
      queues.set(method, [...(queues.get(method) ?? []), ...answers])
      return client
    },
    argsOf: (method: FakeLoginMethod) => calls.filter((call) => call.method === method).map((call) => call.arg),
    getMe: (...args: unknown[]) => answer("getMe", args[0]),
    sendCode: (arg: unknown) => answer("sendCode", arg),
    signIn: (arg: unknown) => answer("signIn", arg),
    checkPassword: (arg: unknown) => answer("checkPassword", arg),
    signInQr: (arg: unknown) => answer("signInQr", arg),
    importSession: (...args: unknown[]) => answer("importSession", args),
  }
  return client as unknown as FakeLoginClient
}

/** The fake io with its scripting and its record. */
export type FakeLoginIo = LoginIo & {
  said: string[]
  qrs: string[]
  /** Every prompt asked, visible or hidden, in order. */
  prompts: string[]
  /** The prompts asked without echo. */
  hiddenPrompts: string[]
  controller: AbortController
}

/** An io that answers visible questions from `answers` and hidden ones from `hidden`, in order. */
export function createFakeLoginIo(answers: string[] = [], hidden: string[] = []): FakeLoginIo {
  const controller = new AbortController()
  const asked = [...answers]
  const askedHidden = [...hidden]
  const io: FakeLoginIo = {
    said: [],
    qrs: [],
    prompts: [],
    hiddenPrompts: [],
    controller,
    signal: controller.signal,
    async ask(prompt) {
      io.prompts.push(prompt)
      const next = asked.shift()
      if (next === undefined) throw new Error("no scripted answer left for ask")
      return next
    },
    async askHidden(prompt) {
      io.prompts.push(prompt)
      io.hiddenPrompts.push(prompt)
      const next = askedHidden.shift()
      if (next === undefined) throw new Error("no scripted answer left for askHidden")
      return next
    },
    say: (line) => void io.said.push(line),
    showQr: (url) => void io.qrs.push(url),
  }
  return io
}
