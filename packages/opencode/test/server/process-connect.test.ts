import { afterEach, describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Proc } from "../../src/process"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await resetDatabase()
})

Log.init({ print: false })

describe("process connect", () => {
  test("streams output before process exit", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_test"),
          fn: async () => {
            const info = await Proc.start({
              command:
                "bun -e \"setTimeout(() => console.log('one'), 50); setTimeout(() => console.log('two'), 100); setTimeout(() => process.exit(0), 300)\"",
              title: "dev",
            })
            const app = Server.Default()
            const stop = new AbortController()
            const client = createOpencodeClient({
              baseUrl: "http://opencode.test",
              directory: tmp.path,
              experimental_workspaceID: "wrk_test",
              fetch: ((input, init) => app.request(input, init)) as typeof fetch,
            })
            const seen: Array<{ type: string; text?: string; exitCode?: number | null }> = []

            try {
              const events = await client.process.connect(
                {
                  processID: info.id,
                  cursor: 0,
                },
                { signal: stop.signal },
              )

              await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("timed out waiting for process output")), 3000)
                ;(async () => {
                  for await (const event of events.stream) {
                    const next = event as { type?: string; text?: string; exitCode?: number | null }
                    if (!next.type || next.type === "connected") continue
                    seen.push({ type: next.type, text: next.text, exitCode: next.exitCode })
                    if (next.type !== "exit") continue
                    clearTimeout(timeout)
                    resolve()
                    return
                  }
                })().catch((error) => {
                  clearTimeout(timeout)
                  reject(error)
                })
              })

              expect(seen.some((item) => item.type === "output" && item.text?.includes("one"))).toBe(true)
              expect(seen.some((item) => item.type === "output" && item.text?.includes("two"))).toBe(true)
            } finally {
              stop.abort()
            }
          },
        })
      },
    })
  })

  test("resumes from last event id", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_test"),
          fn: async () => {
            const info = await Proc.start({
              command:
                "bun -e \"setTimeout(() => console.log('one'), 50); setTimeout(() => console.log('two'), 200); setTimeout(() => process.exit(0), 500)\"",
              title: "dev",
            })
            const app = Server.Default()

            const read = async (res: Response, waitFor: (event: { type?: string; text?: string }) => boolean) => {
              if (!res.body) throw new Error("missing stream body")
              const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
              let buf = ""

              try {
                while (true) {
                  const { done, value } = await reader.read()
                  if (done) throw new Error("stream ended before expected event")
                  buf += value
                  const chunks = buf.split("\n\n")
                  buf = chunks.pop() ?? ""

                  for (const chunk of chunks) {
                    let id: string | undefined
                    const data: string[] = []

                    for (const line of chunk.split("\n")) {
                      if (line.startsWith("id:")) id = line.replace(/^id:\s*/, "")
                      if (line.startsWith("data:")) data.push(line.replace(/^data:\s*/, ""))
                    }

                    if (data.length === 0) continue
                    const event = JSON.parse(data.join("\n")) as { type?: string; text?: string }
                    if (!waitFor(event)) continue
                    return { event, id }
                  }
                }
              } finally {
                await reader.cancel().catch(() => undefined)
              }
            }

            const first = await app.request(`http://opencode.test/process/${info.id}/connect?cursor=0`, {
              headers: {
                "x-opencode-directory": tmp.path,
                "x-opencode-workspace": "wrk_test",
              },
            })

            const seen = await read(first, (event) => event.type === "output" && event.text?.includes("one") === true)
            expect(seen.id).toBeDefined()

            const next = await app.request(`http://opencode.test/process/${info.id}/connect?cursor=0`, {
              headers: {
                "Last-Event-ID": seen.id!,
                "x-opencode-directory": tmp.path,
                "x-opencode-workspace": "wrk_test",
              },
            })

            const resumed = await read(next, (event) => event.type === "output")
            expect(resumed.event.text).toContain("two")
            expect(resumed.event.text).not.toContain("one")
          },
        })
      },
    })
  })
})
