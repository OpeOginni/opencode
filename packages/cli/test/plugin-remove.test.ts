import { expect, test } from "bun:test"
import { realpath } from "node:fs/promises"
import path from "node:path"
import { parse } from "jsonc-parser"
import { configuredPlugins } from "../src/commands/handlers/plugin/config"
import { removePluginConfig } from "../src/commands/handlers/plugin/remove"
import { tmpdir } from "./fixture/tmpdir"
import { isolatedEnv } from "./fixture/environment"

test("removal inventory sorts by scope and target without merging configuration sources", async () => {
  await using directory = await tmpdir()
  const project = path.join(directory.path, "project")
  const global = path.join(directory.path, "global")
  await Bun.write(
    path.join(project, "opencode.json"),
    JSON.stringify({
      plugins: ["z-plugin", "shared-plugin", "shared-plugin", "*", "-disabled", "opencode.provider.openai", "acme.*"],
    }),
  )
  await Bun.write(
    path.join(project, ".opencode/opencode.jsonc"),
    '{"plugins":[{"package":"a-plugin","options":{"a":true}}]}',
  )
  await Bun.write(path.join(global, "opencode.json"), '{"plugins":["shared-plugin"]}')
  await Bun.write(path.join(global, "opencode.jsonc"), '{"plugins":["jsonc-plugin"]}')
  await Bun.write(path.join(global, "cli.json"), '{"plugins":["tui-plugin","-opencode.tabs"]}')

  expect(await configuredPlugins({ directory: project, global, cli: path.join(global, "cli.json") })).toEqual([
    { scope: "project", runtime: "server", target: "a-plugin", path: path.join(project, ".opencode/opencode.jsonc") },
    { scope: "project", runtime: "server", target: "shared-plugin", path: path.join(project, "opencode.json") },
    { scope: "project", runtime: "server", target: "z-plugin", path: path.join(project, "opencode.json") },
    { scope: "global", runtime: "server", target: "jsonc-plugin", path: path.join(global, "opencode.jsonc") },
    { scope: "global", runtime: "server", target: "shared-plugin", path: path.join(global, "opencode.json") },
    { scope: "global", runtime: "tui", target: "tui-plugin", path: path.join(global, "cli.json") },
  ])
})

test("removal inventory finds all project config forms inherited by nested directories", async () => {
  await using directory = await tmpdir()
  const files = ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"]
  await Promise.all(files.map((file) => Bun.write(path.join(directory.path, file), '{"plugins":["inherited-plugin"]}')))
  const entries = await configuredPlugins({
    directory: path.join(directory.path, "packages/app"),
    global: path.join(directory.path, "global"),
    cli: path.join(directory.path, "global/cli.json"),
  })
  expect(entries.map((entry) => entry.path).sort()).toEqual(files.map((file) => path.join(directory.path, file)).sort())
  expect(entries.every((entry) => entry.scope === "project")).toBe(true)
})

test("global config encountered in the ancestor walk is not also offered as project config", async () => {
  await using directory = await tmpdir()
  await Bun.write(path.join(directory.path, "opencode.json"), '{"plugins":["global-plugin"]}')
  const entries = await configuredPlugins({
    directory: directory.path,
    global: directory.path,
    cli: path.join(directory.path, "cli.json"),
  })
  expect(entries).toHaveLength(1)
  expect(entries[0].scope).toBe("global")
})

test("explicit scope does not read or validate the other scope", async () => {
  await using directory = await tmpdir()
  const project = path.join(directory.path, "project")
  const global = path.join(directory.path, "global")
  await Bun.write(path.join(project, "opencode.json"), "{ invalid")
  await Bun.write(path.join(global, "opencode.json"), '{"plugins":["global-plugin"]}')
  expect(
    await configuredPlugins({ directory: project, global, cli: path.join(global, "cli.json"), scope: "global" }),
  ).toHaveLength(1)
})

test("removal preserves comments, unrelated settings, and other plugin options in the selected file only", async () => {
  await using directory = await tmpdir()
  const project = path.join(directory.path, "opencode.jsonc")
  const global = path.join(directory.path, "global/opencode.json")
  await Bun.write(
    project,
    '{\n // keep\n "model":"test/model",\n "plugins":["remove-me",{"package":"remove-me","options":{}},{"package":"keep-me","options":{"a":true}}],\n}\n',
  )
  const untouched = '{"plugins":["remove-me"]}'
  await Bun.write(global, untouched)
  expect(await removePluginConfig(project, "remove-me")).toBe(true)
  const text = await Bun.file(project).text()
  expect(text).toContain("// keep")
  expect(parse(text)).toEqual({ model: "test/model", plugins: [{ package: "keep-me", options: { a: true } }] })
  expect(await Bun.file(global).text()).toBe(untouched)
  expect(await removePluginConfig(project, "remove-me")).toBe(false)
  expect(await Bun.file(project).text()).toBe(text)
})

test.each(["{ invalid", "[]", '{"plugins":{}}', '{"plugins":[{"package":42}]}'])(
  "invalid configuration %s is never overwritten by removal",
  async (text) => {
    await using directory = await tmpdir()
    const file = path.join(directory.path, "opencode.json")
    await Bun.write(file, text)
    await expect(removePluginConfig(file, "plugin")).rejects.toThrow("Invalid plugin configuration")
    expect(await Bun.file(file).text()).toBe(text)
  },
)

test("removing from a missing configuration does not create it", async () => {
  await using directory = await tmpdir()
  const file = path.join(directory.path, "opencode.json")
  expect(await removePluginConfig(file, "missing")).toBe(false)
  expect(await Bun.file(file).exists()).toBe(false)
})

test("CLI removes only the requested scope and handles TUI-only global entries", async () => {
  await using directory = await tmpdir()
  const project = path.join(directory.path, "opencode.json")
  const global = path.join(directory.path, "config/cli.json")
  await Bun.write(project, '{"plugins":["shared-plugin"]}')
  await Bun.write(global, '{"plugins":["shared-plugin"],"theme":{"mode":"dark"}}')

  const local = await cli(directory.path, ["shared-plugin", "--local"])
  expect({ code: local.exitCode, stderr: local.stderr }).toEqual({ code: 0, stderr: "" })
  expect(local.stdout).toContain(`removed from ${await realpath(project)}`)
  expect(await Bun.file(project).json()).toEqual({ plugins: [] })
  expect(await Bun.file(global).json()).toEqual({ plugins: ["shared-plugin"], theme: { mode: "dark" } })

  const removed = await cli(directory.path, ["shared-plugin", "--global", "--yes"])
  expect({ code: removed.exitCode, stderr: removed.stderr }).toEqual({ code: 0, stderr: "" })
  expect(removed.stdout).toContain(`removed from ${global}`)
  expect(await Bun.file(global).json()).toEqual({ plugins: [], theme: { mode: "dark" } })
})

test("CLI refuses ambiguous noninteractive removal without changing either configuration", async () => {
  await using directory = await tmpdir()
  const project = path.join(directory.path, "opencode.json")
  const global = path.join(directory.path, "config/opencode.json")
  const text = '{"plugins":["shared-plugin"]}'
  await Promise.all([Bun.write(project, text), Bun.write(global, text)])
  const result = await cli(directory.path, ["shared-plugin", "--yes"])
  expect(result.exitCode).toBe(1)
  expect(result.stdout + result.stderr).toContain("ambiguous")
  expect(result.stdout + result.stderr).toContain("--local or --global")
  expect(await Bun.file(project).text()).toBe(text)
  expect(await Bun.file(global).text()).toBe(text)
})

test("CLI without a target fails clearly outside a terminal", async () => {
  await using directory = await tmpdir()
  const result = await cli(directory.path, [])
  expect(result.exitCode).toBe(1)
  expect(result.stdout + result.stderr).toContain("Pass a plugin target")
})

async function cli(root: string, args: string[]) {
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "--preload",
      import.meta.resolve("@opentui/solid/preload"),
      path.join(import.meta.dir, "../src/index.ts"),
      "plugin",
      "remove",
      ...args,
    ],
    { cwd: root, env: isolatedEnv(root), stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}
