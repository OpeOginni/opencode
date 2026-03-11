import { text } from "node:stream/consumers"
import { Process } from "./packages/opencode/src/util/process"

function run() {
  return Process.spawn([process.execPath, "info", "semver", "version"], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      BUN_BE_BUN: "1",
    },
  })
}

async function old() {
  const proc = run()
  const code = await proc.exited
  const stdout = proc.stdout ? await text(proc.stdout) : ""
  const stderr = proc.stderr ? await text(proc.stderr) : ""
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

async function next() {
  const out = await Process.text([process.execPath, "info", "semver", "version"], {
    env: {
      ...process.env,
      BUN_BE_BUN: "1",
    },
  })
  return { code: out.code, stdout: out.stdout.toString().trim(), stderr: out.stderr.toString().trim() }
}

const [a, b] = await Promise.all([old(), next()])

console.log("old", a)
console.log("new", b)
console.log("reproduced", a.stdout.length === 0 && b.stdout.length > 0)
