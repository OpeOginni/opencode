import path from "path"
import fs from "fs/promises"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"

export namespace CloudPatch {
  const base = path.join(Global.Path.data, "cloud", "patch")

  type State = {
    applied: boolean
    updated: number
  }

  const files = (sessionID: string) => {
    const root = path.join(base, sessionID)
    return {
      root,
      apply: path.join(root, "apply.patch"),
      state: path.join(root, "state.json"),
    }
  }

  async function exists(file: string) {
    return Bun.file(file).exists()
  }

  async function readState(file: string): Promise<State | undefined> {
    const state = await Bun.file(file)
      .json()
      .catch(() => undefined)
    if (!state || typeof state !== "object") return
    if (typeof state.applied !== "boolean") return
    if (typeof state.updated !== "number") return
    return state as State
  }

  async function writeState(file: string, state: State) {
    await Bun.write(file, JSON.stringify(state, null, 2))
  }

  export async function write(input: { sessionID: string; patch?: string }) {
    const target = files(input.sessionID)
    await fs.mkdir(target.root, { recursive: true })
    if (input.patch !== undefined) {
      const normalized = input.patch
        .replace(/^\uFEFF/, "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
      const output = normalized.endsWith("\n") ? normalized : normalized + "\n"
      await Bun.write(target.apply, output)
    }
    await writeState(target.state, { applied: false, updated: Date.now() })
  }

  export async function status(sessionID: string) {
    const target = files(sessionID)
    const [hasApply, state] = await Promise.all([exists(target.apply), readState(target.state)])

    Log.create({ service: "Cloud-Patch" }).info("fetch", { hasApply, state })
    return {
      hasApply,
      hasRevert: hasApply,
      applied: state?.applied ?? false,
    }
  }

  async function runGit(args: string[]) {
    const proc = Bun.spawn(["git", ...args], {
      cwd: Instance.worktree,
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = await new Response(proc.stdout).text().then((value) => value.trim())
    const stderr = await new Response(proc.stderr).text().then((value) => value.trim())
    const code = await proc.exited
    if (code === 0) return { ok: true, stdout, stderr }
    return {
      ok: false,
      stdout,
      stderr,
      error: stderr || stdout || `git ${args[0]} failed`,
    }
  }

  export async function apply(sessionID: string, direction: "apply" | "revert") {
    const target = files(sessionID)
    const patch = target.apply
    if (!(await exists(patch))) return { ok: false, error: "Patch not found" }

    const args = direction === "revert" ? ["apply", "-R", patch] : ["apply", patch]
    const result = await runGit(args)
    if (!result.ok) return { ok: false, error: result.error }

    await writeState(target.state, { applied: direction === "apply", updated: Date.now() })
    return { ok: true }
  }

  export async function clear(sessionID: string) {
    const target = files(sessionID)
    await fs.rm(target.root, { recursive: true, force: true }).catch(() => {})
  }
}
