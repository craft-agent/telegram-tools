/** `?, ?, ?` for `count` parameters. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ")
}
