import { z } from "zod"
import { defineTool, type OptionSpec, type ToolSpec } from "../core"
import { PROJECT } from "../project"

/** A tool that shows the tool options its call got, for the tests of every entry point. */

/** The tool option the test profiles carry. */
export const NOTE_OPTION = "note_text"
export const NOTE_ID = "demo_note_stamp"

/** The options the test profiles declare: the package's own settings, then the note option. */
export const PROFILE_OPTIONS: Readonly<Record<string, OptionSpec>> = { ...PROJECT.options, [NOTE_OPTION]: "text" }

const optionValueSchema = z.union([z.string(), z.boolean(), z.number(), z.array(z.string()).readonly()])

/** An add tool of `alpha` that returns `ctx.options` and shows the note option as a fact of its description. */
export const noteSpec: ToolSpec = defineTool({
  id: NOTE_ID,
  title: NOTE_ID,
  description: NOTE_ID,
  toolset: "alpha",
  class: "add",
  targets: () => ["north"],
  describe: (_args, ctx) => ({
    facts: [{ label: "Note", value: String(ctx.options?.[NOTE_OPTION] ?? "none") }],
  }),
  input: z.object({}),
  output: z.object({ options: z.record(z.string(), optionValueSchema) }),
  async execute(_args, ctx) {
    return { options: { ...ctx.options } }
  },
})
