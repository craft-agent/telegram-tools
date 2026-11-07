import { usageError } from "./command-args"
import { defaultReadHidden, defaultReadLine, type CommandIo } from "./command-io"

/** Whether the command runs on an interactive terminal. */
export function isTerminal(io: CommandIo): boolean {
  return io.isTTY ?? Boolean(process.stdin.isTTY)
}

function requireTerminal(io: CommandIo): void {
  if (!isTerminal(io)) throw usageError("This asks for input, which needs a terminal.")
}

/** Asks a question on the terminal and returns the answer, which stays visible. */
export async function askLine(io: CommandIo, prompt: string): Promise<string> {
  requireTerminal(io)
  return (await (io.readLine ?? defaultReadLine)(prompt)) ?? ""
}

/** Asks a question on the terminal whose answer is not echoed. */
export async function askHidden(io: CommandIo, prompt: string): Promise<string> {
  requireTerminal(io)
  return (await (io.readHidden ?? defaultReadHidden)(prompt)) ?? ""
}
