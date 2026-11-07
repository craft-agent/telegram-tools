/** The longest request line the service reads, in characters, the line break not counted; a longer one ends the connection. */
export const MAX_REQUEST_LINE_LENGTH = 1024 * 1024

/** What one chunk of a stream held: the lines it completed, and whether a line outgrew the limit. */
export type LineChunk = { lines: string[]; overflow: boolean }

/**
 * Splits a text stream into lines. The pieces of an unfinished line are joined
 * only once it ends; a line longer than `maxLength` characters (the newline
 * not counted) stops the reading, and the lines before it are still returned.
 */
export class LineReader {
  private readonly maxLength: number
  private parts: string[] = []
  private length = 0

  constructor(maxLength: number) {
    this.maxLength = maxLength
  }

  /** Feeds the next chunk of the stream. */
  push(chunk: string): LineChunk {
    const lines: string[] = []
    let start = 0
    for (let end = chunk.indexOf("\n"); end !== -1; end = chunk.indexOf("\n", start)) {
      if (!this.add(chunk.slice(start, end))) return { lines, overflow: true }
      lines.push(this.take())
      start = end + 1
    }
    return { lines, overflow: start < chunk.length && !this.add(chunk.slice(start)) }
  }

  /** Adds a piece to the current line; false when the line grew too long. */
  private add(piece: string): boolean {
    this.parts.push(piece)
    this.length += piece.length
    return this.length <= this.maxLength
  }

  /** The current line, whole; starts the next one. */
  private take(): string {
    const line = this.parts.length === 1 ? this.parts[0]! : this.parts.join("")
    this.parts = []
    this.length = 0
    return line
  }
}
