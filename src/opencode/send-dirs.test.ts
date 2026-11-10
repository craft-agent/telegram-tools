import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { defineTool, type ToolSpec } from "../core"
import { PROFILE } from "./testing"
import type { V1ToolContext, V2Context, V2Tool } from "./types"
import { createV1Server } from "./v1"
import { createV2Setup } from "./v2"

type Recorder = { target?: readonly string[]; execute?: readonly string[] }

describe("OpenCode send_dirs setting", () => {
  const SESSION_ID = "ses_send"

  function sendTool(recorder: Recorder): ToolSpec {
    return defineTool({
      id: "demo_send_tool",
      title: "Send Tool",
      description: "Send Tool",
      toolset: "alpha",
      class: "add",
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      async targets(_args, ctx) {
        recorder.target = ctx.sendDirs
        return ["target-resource"]
      },
      async execute(_args, ctx) {
        recorder.execute = ctx.sendDirs
        return { ok: true }
      },
    })
  }

  const v1Context: V1ToolContext = {
    directory: "/work/project",
    worktree: "/work/project",
    abort: new AbortController().signal,
    async ask() {},
  }

  function v2Context(options: Record<string, unknown>, tools: Map<string, V2Tool>): V2Context {
    return {
      options,
      session: {
        async get() {
          return { location: { directory: "/work/project" } }
        },
      },
      permission: { async assert() {} },
      tool: { transform: async (cb) => cb({ add: (t) => tools.set(t.name, t) }) },
      skill: { transform: async () => {} },
    }
  }

  describe("V1", () => {
    test("passes sendDirs from options, then from DEMO_SEND_DIRS, into the call", async () => {
      const recorder: Recorder = {}
      const { tool } = await createV1Server([sendTool(recorder)], { profile: PROFILE })(
        {},
        { send_dirs: ["/v1/a", "/v1/b"] },
      )
      await tool.demo_send_tool!.execute({}, v1Context)
      expect(recorder.execute).toEqual(["/v1/a", "/v1/b"])

      const fromEnv = await createV1Server([sendTool(recorder)], {
        profile: PROFILE,
        env: { DEMO_SEND_DIRS: "/v1/env" },
      })({}, {})
      await fromEnv.tool.demo_send_tool!.execute({}, v1Context)
      expect(recorder.execute).toEqual(["/v1/env"])
    })

    test("rejects an invalid send_dirs option", async () => {
      const server = createV1Server([], { profile: PROFILE })
      await expect(server({}, { send_dirs: "/a,/b" })).rejects.toThrow('Option "send_dirs"')
      await expect(server({}, { send_dirs: ["relative/path"] })).rejects.toThrow('Option "send_dirs"')
    })
  })

  describe("V2", () => {
    test("passes sendDirs from options into permissionResources and runTool", async () => {
      const recorder: Recorder = {}
      const tools = new Map<string, V2Tool>()
      await createV2Setup([sendTool(recorder)], { profile: PROFILE })(v2Context({ send_dirs: ["/v2/a"] }, tools))
      await tools.get("demo_send_tool")!.execute({}, { sessionID: SESSION_ID, signal: new AbortController().signal })
      expect(recorder.target).toEqual(["/v2/a"])
      expect(recorder.execute).toEqual(["/v2/a"])
    })

    test("falls back to environment variable DEMO_SEND_DIRS", async () => {
      const recorder: Recorder = {}
      const tools = new Map<string, V2Tool>()
      await createV2Setup([sendTool(recorder)], { profile: PROFILE, env: { DEMO_SEND_DIRS: "/v2/env/a,/v2/env/b" } })(
        v2Context({}, tools),
      )
      await tools.get("demo_send_tool")!.execute({}, { sessionID: SESSION_ID, signal: new AbortController().signal })
      expect(recorder.execute).toEqual(["/v2/env/a", "/v2/env/b"])
    })

    test("rejects an invalid send_dirs option", async () => {
      const setup = createV2Setup([], { profile: PROFILE })
      await expect(setup(v2Context({ send_dirs: ["relative/path"] }, new Map()))).rejects.toThrow('Option "send_dirs"')
      await expect(setup(v2Context({ send_dirs: 7 }, new Map()))).rejects.toThrow('Option "send_dirs"')
    })
  })
})
