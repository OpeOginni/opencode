import { WorkspaceContext } from "@/control-plane/workspace-context"
import { Proc } from "@/process"
import { ProcessID } from "@/process/schema"
import { Instance } from "@/project/instance"
import path from "path"
import z from "zod"
import DESCRIPTION from "./process.txt"
import { Tool } from "./tool"

const operations = ["start", "stop", "listen", "tail", "list"] as const
const MAX = 30_000

type Meta = {
  count?: number
  processes?: Proc.Info[]
  processID?: ProcessID
  pid?: number
  cwd?: string
  title?: string
  command?: string
  timeout?: number
  bytes?: number
  lines?: number
  output?: string
  cursor?: number
  running?: boolean
  truncated?: boolean
  reason?: "timeout" | "max_bytes" | "max_lines" | "exit" | "aborted"
  exitCode?: number | null
  signal?: string | null
}

export const ProcessTool = Tool.define("process", {
  description: DESCRIPTION,
  parameters: z.object({
    operation: z.enum(operations),
    command: z.string().optional(),
    cwd: z.string().optional(),
    title: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    process_id: z.string().optional().describe("The managed process ID"),
    cursor: z.number().int().min(-1).optional(),
    timeout_ms: z.number().int().positive().optional(),
    max_bytes: z.number().int().positive().optional(),
    max_lines: z.number().int().positive().optional(),
  }),
  async execute(args, ctx): Promise<{ title: string; metadata: Meta; output: string }> {
    if (args.operation === "list") {
      const list = Proc.list()
      return {
        title: "List processes",
        metadata: { count: list.length, processes: list },
        output:
          list.length === 0
            ? "No active processes."
            : list.map((item) => `${item.id} pid=${item.pid} cwd=${item.cwd} title=${item.title}`).join("\n"),
      }
    }

    if (args.operation === "start") {
      if (!args.command) throw new Error("command is required when operation is start")
      const cwd = (() => {
        if (!args.cwd) return Instance.directory
        if (path.isAbsolute(args.cwd)) return args.cwd
        return path.resolve(Instance.directory, args.cwd)
      })()
      if (!Instance.containsPath(cwd)) {
        await ctx.ask({
          permission: "external_directory",
          patterns: [path.join(cwd, "*")],
          always: [path.join(cwd, "*")],
          metadata: {},
        })
      }
      await ctx.ask({
        permission: "bash",
        patterns: [args.command],
        always: [],
        metadata: { workspaceID: WorkspaceContext.workspaceID },
      })
      const info = await Proc.start(
        {
          command: args.command,
          cwd,
          title: args.title,
          env: args.env,
        },
        { sessionID: ctx.sessionID, callID: ctx.callID },
      )
      return {
        title: `Start ${info.title}`,
        metadata: {
          processID: info.id,
          pid: info.pid,
          cwd: info.cwd,
          title: info.title,
          cursor: 0,
        },
        output: `Started ${info.title} (${info.id}) with pid ${info.pid}.`,
      }
    }

    if (!args.process_id) throw new Error("process_id is required for this operation")
    const id = ProcessID.zod.parse(args.process_id)

    if (args.operation === "stop") {
      const ok = await Proc.stop(id)
      if (!ok) throw new Error(`Process not found: ${id}`)
      return {
        title: `Stop ${id}`,
        metadata: { processID: id },
        output: `Stop requested for process ${id}.`,
      }
    }

    const info = Proc.get(id)
    if (!info) throw new Error(`Process not found: ${id}`)
    const tail = args.operation === "tail"
    const cursor = tail ? -1 : args.cursor
    const title = `${tail ? "Tailing" : "Listening to"} ${info.title}`
    const timeout = args.timeout_ms ?? 2_000
    let output = ""
    const meta = () => ({
      processID: id,
      title: info.title,
      command: info.command,
      cwd: info.cwd,
      pid: info.pid,
      timeout,
      bytes: args.max_bytes,
      lines: args.max_lines,
      output: output.length > MAX ? output.slice(0, MAX) + "\n\n..." : output,
    })
    const apply = (text: string) => {
      output += text
      void ctx.metadata({
        title,
        metadata: meta(),
      })
    }

    const conn = Proc.connect(id, cursor)
    if (!conn) throw new Error(`Process not found: ${id}`)
    output = conn.first.text
    await Promise.resolve()
    await ctx.metadata({
      title,
      metadata: meta(),
    })

    const off = conn.subscribe((event) => {
      if (event.type !== "output") return
      apply(event.text)
    })

    const out = await Proc.listen(
      id,
      {
        cursor,
        stream: "combined",
        timeoutMs: timeout,
        maxBytes: args.max_bytes,
        maxLines: args.max_lines,
      },
      ctx.abort,
    ).finally(off)
    if (!out) throw new Error(`Process not found: ${id}`)
    return {
      title: `${tail ? "Tailing" : "Listening to"} ${out.title}`,
      metadata: {
        processID: id,
        title: out.title,
        command: out.command,
        cwd: out.cwd,
        pid: out.pid,
        timeout,
        bytes: args.max_bytes,
        lines: args.max_lines,
        output: out.text.length > MAX ? out.text.slice(0, MAX) + "\n\n..." : out.text,
        cursor: out.cursor,
        running: out.running,
        truncated: out.truncated,
        reason: out.reason,
        exitCode: out.exitCode,
        signal: out.signal,
      },
      output: (() => {
        const meta = (() => {
          if (out.reason === "exit") return `[process exited with code ${out.exitCode ?? 0}]`
          if (out.reason === "max_bytes") return "[listen stopped after reaching byte limit]"
          if (out.reason === "max_lines") return "[listen stopped after reaching line limit]"
          if (out.reason === "aborted") return "[listen aborted]"
          return `[listen stopped after ${timeout}ms]`
        })()
        if (out.text) return `${out.text}\n\n${meta}`
        return meta
      })(),
    }
  },
})
