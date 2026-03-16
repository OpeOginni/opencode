import { describe, expect, test } from "bun:test"
import { ProcessTool } from "../../src/tool/process"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import type { PermissionNext } from "../../src/permission/next"
import { SessionID, MessageID } from "../../src/session/schema"

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

describe("tool.process", () => {
  test("starts, listens to, and stops a managed process", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ProcessTool.init()
        const reqs: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const meta: Array<{ title?: string; metadata?: Record<string, unknown> }> = []
        const testCtx = {
          ...ctx,
          metadata: async (value: { title?: string; metadata?: Record<string, unknown> }) => {
            meta.push(value)
          },
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            reqs.push(req)
          },
        }

        const started = await tool.execute(
          {
            operation: "start",
            command: `bun -e "console.log('ready'); console.log('next'); setInterval(() => {}, 1000)"`,
            title: "dev",
          },
          testCtx,
        )
        expect(reqs.some((req) => req.permission === "bash")).toBe(true)

        const id = started.metadata.processID
        const cursor = started.metadata.cursor
        expect(id).toBeDefined()
        expect(cursor).toBe(0)

        const listened = await tool.execute(
          {
            operation: "listen",
            process_id: id,
            cursor,
            timeout_ms: 2000,
            max_lines: 1,
          },
          testCtx,
        )
        expect(meta.some((item) => item.title === "Listening to dev")).toBe(true)
        expect(meta.some((item) => String(item.metadata?.output ?? "").includes("ready"))).toBe(true)
        expect(String(listened.metadata.output ?? "")).toContain("ready")
        expect(listened.output).toContain("ready")
        expect(listened.output).toContain("line limit")

        const stopped = await tool.execute(
          {
            operation: "stop",
            process_id: id,
          },
          testCtx,
        )
        expect(stopped.output).toContain(String(id))
      },
    })
  })

  test("tails only fresh output", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ProcessTool.init()
        const started = await tool.execute(
          {
            operation: "start",
            command: `bun -e "console.log('old'); setTimeout(() => console.log('new'), 150); setInterval(() => {}, 1000)"`,
            title: "dev",
          },
          ctx,
        )

        await Bun.sleep(75)

        const tailed = await tool.execute(
          {
            operation: "tail",
            process_id: String(started.metadata.processID),
            timeout_ms: 1000,
            max_lines: 1,
          },
          ctx,
        )

        expect(tailed.output).toContain("new")
        expect(tailed.output).not.toContain("old")

        await tool.execute(
          {
            operation: "stop",
            process_id: String(started.metadata.processID),
          },
          ctx,
        )
      },
    })
  })
})
