import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { WorkspaceID } from "@/control-plane/schema"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { Instance } from "@/project/instance"
import type { MessageID, SessionID } from "@/session/schema"
import { Shell } from "@/shell/shell"
import { Log } from "@/util/log"
import { spawn, type ChildProcess } from "child_process"
import path from "path"
import z from "zod"
import { ProcessID } from "./schema"

export namespace Proc {
  const log = Log.create({ service: "process" })
  const LIMIT = 1024 * 1024 * 2

  type Buf = {
    text: string
    start: number
    cursor: number
  }

  type Exit = {
    code: number | null
    signal: string | null
  }

  type Wait = () => void
  type Sub = (event: { type: "output"; text: string; cursor: number } | { type: "exit"; exit: Exit }) => void

  export const Stream = z.enum(["combined", "stdout", "stderr"]).meta({ ref: "ProcessStream" })

  export const Info = z
    .object({
      id: ProcessID.zod,
      workspaceID: WorkspaceID.zod.optional(),
      title: z.string(),
      command: z.string(),
      cwd: z.string(),
      status: z.literal("running"),
      pid: z.number(),
      startedAt: z.number(),
    })
    .meta({ ref: "ProcessInfo" })

  export type Info = z.infer<typeof Info>

  export const StartInput = z.object({
    command: z.string(),
    cwd: z.string().optional(),
    title: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })

  export type StartInput = z.infer<typeof StartInput>

  export const StopInput = z.object({})

  export const ListenInput = z.object({
    cursor: z.coerce.number().int().min(-1).optional(),
    stream: Stream.optional(),
    timeoutMs: z.coerce.number().int().positive(),
    maxBytes: z.coerce.number().int().positive().optional(),
    maxLines: z.coerce.number().int().positive().optional(),
  })

  export type ListenInput = z.infer<typeof ListenInput>

  export const ListenOutput = z
    .object({
      processID: ProcessID.zod,
      title: z.string(),
      command: z.string(),
      cwd: z.string(),
      pid: z.number(),
      cursor: z.number(),
      text: z.string(),
      running: z.boolean(),
      truncated: z.boolean(),
      reason: z.enum(["timeout", "max_bytes", "max_lines", "exit", "aborted"]),
      exitCode: z.number().nullable().optional(),
      signal: z.string().nullable().optional(),
    })
    .meta({ ref: "ProcessLogs" })

  export type ListenOutput = z.infer<typeof ListenOutput>

  export const Event = {
    Started: BusEvent.define("process.started", z.object({ info: Info })),
    Exited: BusEvent.define(
      "process.exited",
      z.object({
        id: ProcessID.zod,
        exitCode: z.number().nullable(),
        signal: z.string().nullable().optional(),
      }),
    ),
  }

  interface Item {
    info: Info
    proc: ChildProcess
    buf: Record<z.infer<typeof Stream>, Buf>
    wait: Set<Wait>
    sub: Map<symbol, Sub>
    exit?: Exit
  }

  const state = Instance.state(
    () => new Map<ProcessID, Item>(),
    async (map) => {
      await Promise.all(
        Array.from(map.values()).map(async (item) => {
          for (const fn of item.wait) fn()
          item.wait.clear()
          item.sub.clear()
          await Shell.killTree(item.proc, { exited: () => !!item.exit })
        }),
      )
      map.clear()
    },
  )

  const pick = (item: Item, stream: z.infer<typeof Stream>) => item.buf[stream]

  const wake = (item: Item) => {
    const list = Array.from(item.wait)
    item.wait.clear()
    list.forEach((fn) => fn())
  }

  const trim = (buf: Buf) => {
    if (buf.text.length <= LIMIT) return
    const extra = buf.text.length - LIMIT
    buf.text = buf.text.slice(extra)
    buf.start += extra
  }

  const append = (buf: Buf, text: string) => {
    buf.cursor += text.length
    buf.text += text
    trim(buf)
  }

  const scope = (item: Item) => item.info.workspaceID === WorkspaceContext.workspaceID

  const cwd = (input?: string) => {
    if (!input) return Instance.directory
    if (path.isAbsolute(input)) return input
    return path.resolve(Instance.directory, input)
  }

  export function list() {
    return Array.from(state().values())
      .filter(scope)
      .map((item) => item.info)
      .toSorted((a, b) => b.startedAt - a.startedAt)
  }

  export function get(id: ProcessID) {
    const item = state().get(id)
    if (!item || !scope(item)) return
    return item.info
  }

  export async function start(
    input: StartInput,
    opts?: {
      sessionID?: SessionID
      callID?: MessageID | string
    },
  ) {
    const id = ProcessID.ascending()
    const dir = cwd(input.cwd)
    const { Plugin } = await import("@/plugin")
    const shellEnv = await Plugin.trigger(
      "shell.env",
      {
        cwd: dir,
        sessionID: opts?.sessionID,
        callID: opts?.callID,
      },
      { env: {} },
    )
    const proc = spawn(input.command, {
      shell: Shell.acceptable(),
      cwd: dir,
      env: {
        ...process.env,
        ...input.env,
        ...shellEnv.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: process.platform === "win32",
    })

    const info = {
      id,
      workspaceID: WorkspaceContext.workspaceID,
      title: input.title?.trim() || input.command,
      command: input.command,
      cwd: dir,
      status: "running",
      pid: proc.pid ?? -1,
      startedAt: Date.now(),
    } as const
    const item: Item = {
      info,
      proc,
      buf: {
        combined: { text: "", start: 0, cursor: 0 },
        stdout: { text: "", start: 0, cursor: 0 },
        stderr: { text: "", start: 0, cursor: 0 },
      },
      wait: new Set(),
      sub: new Map(),
    }
    state().set(id, item)

    const ondata = (stream: "stdout" | "stderr") => (chunk: string | Buffer) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString() : chunk
      append(item.buf[stream], text)
      append(item.buf.combined, text)
      for (const fn of item.sub.values()) {
        fn({ type: "output", text, cursor: item.buf.combined.cursor })
      }
      wake(item)
    }

    proc.stdout?.on("data", ondata("stdout"))
    proc.stderr?.on("data", ondata("stderr"))
    proc.once("exit", (code, signal) => {
      item.exit = {
        code,
        signal: signal ? String(signal) : null,
      }
      for (const fn of item.sub.values()) {
        fn({ type: "exit", exit: item.exit })
      }
      item.sub.clear()
      state().delete(id)
      wake(item)
      log.info("process exited", { id, code, signal })
      Bus.publish(Event.Exited, {
        id,
        exitCode: code,
        signal: signal ? String(signal) : null,
      })
    })
    proc.once("error", (err) => {
      log.error("process failed", { id, error: err.message })
    })
    log.info("process started", { id, command: input.command, cwd: dir, workspaceID: WorkspaceContext.workspaceID })
    Bus.publish(Event.Started, { info })
    return info
  }

  export async function stop(id: ProcessID) {
    const item = state().get(id)
    if (!item || !scope(item)) return false
    await Shell.killTree(item.proc, { exited: () => !!item.exit })
    return true
  }

  function snap(item: Item, input: ListenInput): ListenOutput {
    const stream = input.stream ?? "combined"
    const buf = pick(item, stream)
    const end = buf.cursor
    const from = input.cursor === -1 ? end : typeof input.cursor === "number" ? input.cursor : 0
    const truncated = from < buf.start
    const off = Math.max(0, from - buf.start)
    return {
      processID: item.info.id,
      title: item.info.title,
      command: item.info.command,
      cwd: item.info.cwd,
      pid: item.info.pid,
      cursor: end,
      text: off >= buf.text.length ? "" : buf.text.slice(off),
      running: !item.exit,
      truncated,
      reason: item.exit ? "exit" : "timeout",
      exitCode: item.exit?.code,
      signal: item.exit?.signal,
    }
  }

  export function connect(id: ProcessID, cursor?: number) {
    const item = state().get(id)
    if (!item || !scope(item)) return
    const key = Symbol(id)
    const first = snap(item, {
      cursor,
      stream: "combined",
      timeoutMs: 1,
    })
    return {
      first,
      subscribe(fn: Sub) {
        item.sub.set(key, fn)
        return () => {
          item.sub.delete(key)
        }
      },
    }
  }

  async function wait(item: Item, ms: number, signal?: AbortSignal) {
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = () => {
        item.wait.delete(done)
        signal?.removeEventListener("abort", done)
        if (timer) clearTimeout(timer)
        resolve()
      }
      item.wait.add(done)
      timer = setTimeout(done, ms)
      signal?.addEventListener("abort", done, { once: true })
      if (item.exit) done()
    })
  }

  function crop(text: string, bytes: number, lines: number) {
    let end = text.length
    let reason: ListenOutput["reason"] | undefined

    if (bytes > 0 && Number.isFinite(bytes) && text.length >= bytes) {
      end = bytes
      reason = "max_bytes"
    }

    if (lines > 0) {
      let count = 0
      for (let i = 0; i < end; i++) {
        if (text[i] !== "\n") continue
        count++
        if (count < lines) continue
        end = i + 1
        reason = "max_lines"
        break
      }
    }

    return {
      text: text.slice(0, end),
      used: end,
      reason,
    }
  }

  export async function listen(id: ProcessID, input: ListenInput, signal?: AbortSignal) {
    const item = state().get(id)
    if (!item || !scope(item)) return
    let cursor = input.cursor === -1 ? pick(item, input.stream ?? "combined").cursor : (input.cursor ?? 0)
    let text = ""
    let truncated = false
    let reason: ListenOutput["reason"] = "timeout"
    let bytes = input.maxBytes ?? Number.POSITIVE_INFINITY
    let lines = input.maxLines ?? Number.POSITIVE_INFINITY
    const end = Date.now() + input.timeoutMs

    while (true) {
      const next = snap(item, { ...input, cursor })
      truncated = truncated || next.truncated

      if (next.text) {
        const part = crop(next.text, bytes, lines)
        text += part.text
        cursor += part.used
        bytes -= part.used
        lines -= part.text.split("\n").length - 1
        if (part.reason) {
          reason = part.reason
          break
        }
      }

      if (!next.running) {
        reason = "exit"
        break
      }

      if (signal?.aborted) {
        reason = "aborted"
        break
      }

      const left = end - Date.now()
      if (left <= 0) {
        reason = "timeout"
        break
      }

      await wait(item, left, signal)
    }

    return {
      processID: item.info.id,
      title: item.info.title,
      command: item.info.command,
      cwd: item.info.cwd,
      pid: item.info.pid,
      cursor,
      text,
      running: !item.exit,
      truncated,
      reason,
      exitCode: item.exit?.code,
      signal: item.exit?.signal,
    }
  }
}
