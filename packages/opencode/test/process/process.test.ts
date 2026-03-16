import { describe, expect, test } from "bun:test"
import { setTimeout as sleep } from "node:timers/promises"
import { WorkspaceID } from "../../src/control-plane/schema"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Proc } from "../../src/process"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const wait = async (fn: () => boolean, ms = 4000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await sleep(25)
  }
  throw new Error("timeout waiting for process state")
}

describe("process", () => {
  test("scopes active processes to the workspace and removes them on exit", async () => {
    await using dir = await tmpdir({ git: true })

    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        await WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_test"),
          fn: async () => {
            const info = await Proc.start({
              command: `bun -e "console.log('ready'); setInterval(() => {}, 1000)"`,
              title: "dev",
            })

            await wait(() => Proc.list().some((item) => item.id === info.id))

            const out = await Proc.listen(info.id, {
              timeoutMs: 2000,
            })
            expect(out?.text).toContain("ready")

            const other = await WorkspaceContext.provide({
              workspaceID: WorkspaceID.make("wrk_other"),
              fn: async () => Proc.list(),
            })
            expect(other).toHaveLength(0)

            await Proc.stop(info.id)
            await wait(() => Proc.list().every((item) => item.id !== info.id))
          },
        })
      },
    })
  })

  test("stops listening when output reaches a limit", async () => {
    await using dir = await tmpdir({ git: true })

    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        await WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_test"),
          fn: async () => {
            const info = await Proc.start({
              command: `bun -e "console.log('one'); console.log('two'); setInterval(() => {}, 1000)"`,
              title: "dev",
            })

            const out = await Proc.listen(info.id, {
              timeoutMs: 2000,
              maxLines: 1,
            })

            expect(out?.reason).toBe("max_lines")
            expect(out?.text).toBe("one\n")

            await Proc.stop(info.id)
          },
        })
      },
    })
  })

  test("captures only new logs when listening later", async () => {
    await using dir = await tmpdir({ git: true })

    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        await WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_test"),
          fn: async () => {
            const info = await Proc.start({
              command:
                "bun -e \"for (const x of ['one','two','three','four']) console.log(x); setTimeout(() => { console.log('five'); console.log('six') }, 300); setInterval(() => {}, 1000)\"",
              title: "dev",
            })
            try {
              await sleep(150)

              const out = await Proc.listen(info.id, {
                cursor: -1,
                timeoutMs: 1500,
                maxLines: 2,
              })

              expect(out?.text).toBe("five\nsix\n")
              expect(out?.reason).toBe("max_lines")
              expect(out?.text.includes("one")).toBe(false)
            } finally {
              await Proc.stop(info.id)
            }
          },
        })
      },
    })
  })

  test("stops listening after reaching a byte limit", async () => {
    await using dir = await tmpdir({ git: true })

    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        await WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_test"),
          fn: async () => {
            const info = await Proc.start({
              command: `bun -e "console.log('abcdef') ; setInterval(() => {}, 1000)"`,
              title: "dev",
            })
            try {
              const out = await Proc.listen(info.id, {
                timeoutMs: 1000,
                maxBytes: 4,
              })

              expect(out?.text).toBe("abcd")
              expect(out?.reason).toBe("max_bytes")
            } finally {
              await Proc.stop(info.id)
            }
          },
        })
      },
    })
  })

  test("stops listening when the process exits", async () => {
    await using dir = await tmpdir({ git: true })

    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        await WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_test"),
          fn: async () => {
            const info = await Proc.start({
              command: `bun -e "setTimeout(() => console.log('done'), 50)"`,
              title: "dev",
            })

            const out = await Proc.listen(info.id, {
              timeoutMs: 1500,
            })

            expect(out?.text).toContain("done")
            expect(out?.reason).toBe("exit")
            expect(out?.running).toBe(false)
            expect(out?.exitCode).toBe(0)
          },
        })
      },
    })
  })

  test("stops listening when the timeout is reached", async () => {
    await using dir = await tmpdir({ git: true })

    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        await WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_test"),
          fn: async () => {
            const info = await Proc.start({
              command: `bun -e "setInterval(() => {}, 1000)"`,
              title: "dev",
            })
            try {
              const out = await Proc.listen(info.id, {
                timeoutMs: 100,
              })

              expect(out?.text).toBe("")
              expect(out?.reason).toBe("timeout")
              expect(out?.running).toBe(true)
            } finally {
              await Proc.stop(info.id)
            }
          },
        })
      },
    })
  })

  test("stops listening when aborted", async () => {
    await using dir = await tmpdir({ git: true })

    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        await WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_test"),
          fn: async () => {
            const info = await Proc.start({
              command: `bun -e "setInterval(() => {}, 1000)"`,
              title: "dev",
            })
            const abort = new AbortController()
            const timer = setTimeout(() => abort.abort(), 50)

            try {
              const out = await Proc.listen(
                info.id,
                {
                  timeoutMs: 1000,
                },
                abort.signal,
              )

              expect(out?.text).toBe("")
              expect(out?.reason).toBe("aborted")
            } finally {
              clearTimeout(timer)
              await Proc.stop(info.id)
            }
          },
        })
      },
    })
  })

  test("streams live output to process subscribers", async () => {
    await using dir = await tmpdir({ git: true })

    await Instance.provide({
      directory: dir.path,
      fn: async () => {
        await WorkspaceContext.provide({
          workspaceID: WorkspaceID.make("wrk_test"),
          fn: async () => {
            const info = await Proc.start({
              command: `bun -e "setTimeout(() => console.log('one'), 50); setTimeout(() => console.log('two'), 100); setInterval(() => {}, 1000)"`,
              title: "dev",
            })
            const conn = Proc.connect(info.id)
            expect(conn).toBeDefined()
            const seen: string[] = []

            try {
              const done = new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("timed out waiting for subscriber output")), 3000)
                const off = conn!.subscribe((event) => {
                  if (event.type !== "output") return
                  seen.push(event.text)
                  if (!seen.join("").includes("two")) return
                  clearTimeout(timer)
                  off()
                  resolve()
                })
              })

              await done
              expect(seen.join("")).toContain("one")
              expect(seen.join("")).toContain("two")
            } finally {
              await Proc.stop(info.id)
            }
          },
        })
      },
    })
  })
})
