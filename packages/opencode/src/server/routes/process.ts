import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import z from "zod"
import { Proc } from "@/process"
import { ProcessID } from "@/process/schema"
import { AsyncQueue } from "@/util/queue"
import { NotFoundError } from "../../storage/db"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

export const ProcessRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List managed processes",
        description: "List all active managed processes for the current workspace.",
        operationId: "process.list",
        responses: {
          200: {
            description: "Processes",
            content: {
              "application/json": {
                schema: resolver(Proc.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(Proc.list())
      },
    )
    .post(
      "/",
      describeRoute({
        summary: "Create managed process",
        description: "Start a managed process for the current workspace.",
        operationId: "process.create",
        responses: {
          200: {
            description: "Process created",
            content: {
              "application/json": {
                schema: resolver(Proc.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Proc.StartInput),
      async (c) => {
        return c.json(await Proc.start(c.req.valid("json")))
      },
    )
    .post(
      "/:processID/stop",
      describeRoute({
        summary: "Stop managed process",
        description: "Stop an active managed process in the current workspace.",
        operationId: "process.stop",
        responses: {
          200: {
            description: "Process stopped",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ processID: ProcessID.zod })),
      validator("json", Proc.StopInput),
      async (c) => {
        const ok = await Proc.stop(c.req.valid("param").processID)
        if (!ok) throw new NotFoundError({ message: "Process not found" })
        return c.json(true)
      },
    )
    .get(
      "/:processID/connect",
      describeRoute({
        summary: "Connect to process logs",
        description: "Establish a live stream of buffered and future logs for an active managed process.",
        operationId: "process.connect",
        responses: {
          200: {
            description: "Connected process log stream",
            content: {
              "text/event-stream": {
                schema: resolver(z.any()),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ processID: ProcessID.zod })),
      validator("query", z.object({ cursor: z.coerce.number().int().min(-1).optional() })),
      async (c) => {
        const cursor = (() => {
          const id = c.req.header("Last-Event-ID")
          if (!id) return c.req.valid("query").cursor
          const n = Number.parseInt(id, 10)
          return Number.isSafeInteger(n) ? n : c.req.valid("query").cursor
        })()
        const conn = Proc.connect(c.req.valid("param").processID, cursor)
        if (!conn) throw new NotFoundError({ message: "Process not found" })
        c.header("X-Accel-Buffering", "no")
        c.header("X-Content-Type-Options", "nosniff")
        return streamSSE(c, async (stream) => {
          const queue = new AsyncQueue<
            | { type: "connected" }
            | { type: "output"; text: string; cursor: number }
            | { type: "exit"; exitCode: number | null; signal: string | null }
          >()

          queue.push({ type: "connected" })

          if (conn.first.text) {
            queue.push({
              type: "output",
              text: conn.first.text,
              cursor: conn.first.cursor,
            })
          }
          if (!conn.first.running) {
            queue.push({
              type: "exit",
              exitCode: conn.first.exitCode ?? 0,
              signal: conn.first.signal ?? null,
            })
          }

          const unsub = conn.subscribe((event) => {
            if (event.type === "output") {
              queue.push(event)
              return
            }
            queue.push({
              type: "exit",
              exitCode: event.exit.code,
              signal: event.exit.signal,
            })
          })

          stream.onAbort(() => {
            clearInterval(heartbeat)
            unsub()
          })

          const heartbeat = setInterval(() => {
            queue.push({ type: "connected" })
          }, 10_000)

          for await (const event of queue) {
            await stream.writeSSE({
              id: event.type === "output" ? String(event.cursor) : undefined,
              data: JSON.stringify(event),
            })
            if (event.type === "exit") {
              clearInterval(heartbeat)
              unsub()
              stream.close()
              return
            }
          }
        })
      },
    )
    .get(
      "/:processID/logs",
      describeRoute({
        summary: "Read process logs",
        description: "Read buffered logs from an active managed process.",
        operationId: "process.logs",
        responses: {
          200: {
            description: "Process logs",
            content: {
              "application/json": {
                schema: resolver(Proc.ListenOutput),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ processID: ProcessID.zod })),
      validator("query", Proc.ListenInput),
      async (c) => {
        const out = await Proc.listen(c.req.valid("param").processID, c.req.valid("query"), c.req.raw.signal)
        if (!out) throw new NotFoundError({ message: "Process not found" })
        return c.json(out)
      },
    ),
)
