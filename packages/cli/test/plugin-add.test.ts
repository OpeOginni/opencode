import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { parse } from "jsonc-parser"
import { Npm } from "@opencode/util/npm"
import { configurationTarget, writePluginConfig } from "../src/commands/handlers/plugin/add"
import { tmpdir } from "./fixture/tmpdir"
import { isolatedEnv } from "./fixture/environment"

const spec = "opencode-test-plugin@1.0.0"

test("plugin add help describes both configuration scopes", async () => {
  await using directory = await tmpdir()
  const result = await cli(directory.path, ["--help"])
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain("--local")
  expect(result.stdout).toContain("--global")
  expect(result.stdout).toContain("project or global configuration")
})

test("plugin add without a package fails clearly outside a terminal", async () => {
  await using directory = await tmpdir()
  const result = await cli(directory.path, [])
  expect(result.exitCode).toBe(1)
  expect(result.stdout + result.stderr).toContain("Pass a plugin package")
  expect(existsSync(path.join(directory.path, "cache/opencode/npm"))).toBe(false)
})

test("--local creates project configuration without changing global configuration", async () => {
  await using directory = await tmpdir()
  await installed(directory.path)
  const global = path.join(directory.path, "config/opencode.json")
  await Bun.write(global, JSON.stringify({ plugins: ["existing-global"] }))

  const result = await cli(directory.path, [spec, "--local"])
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain(path.join(directory.path, "opencode.json"))
  expect(await Bun.file(path.join(directory.path, "opencode.json")).json()).toEqual({
    $schema: "https://opencode.ai/config.json",
    plugins: [spec],
  })
  expect(await Bun.file(global).json()).toEqual({ plugins: ["existing-global"] })
})

test.each(["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"])(
  "--local preserves existing settings and comments in %s",
  async (file) => {
    await using directory = await tmpdir()
    await installed(directory.path)
    const config = path.join(directory.path, file)
    await Bun.write(config, '{\n  // Keep this comment\n  "model": "test/model",\n  "plugins": ["existing"],\n}\n')

    const result = await cli(directory.path, [spec, "--local"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(config)
    const text = await Bun.file(config).text()
    expect(text).toContain("// Keep this comment")
    expect(parse(text)).toEqual({ model: "test/model", plugins: ["existing", spec] })
    expect(await Bun.file(path.join(directory.path, "config/opencode.json")).exists()).toBe(false)
  },
)

test.each(["--global", undefined])("global scope %s leaves project configuration untouched", async (flag) => {
  await using directory = await tmpdir()
  await installed(directory.path)
  const project = path.join(directory.path, "opencode.json")
  await Bun.write(project, JSON.stringify({ plugins: ["existing-project"] }))

  const result = await cli(directory.path, [spec, ...(flag ? [flag] : [])])
  expect(result.exitCode).toBe(0)
  expect(await Bun.file(path.join(directory.path, "config/opencode.json")).json()).toEqual({
    $schema: "https://opencode.ai/config.json",
    plugins: [spec],
  })
  expect(await Bun.file(project).json()).toEqual({ plugins: ["existing-project"] })
})

test("conflicting scope flags fail before installation or config writes", async () => {
  await using directory = await tmpdir()
  const result = await cli(directory.path, [spec, "--local", "--global"])
  expect(result.exitCode).toBe(1)
  expect(result.stdout + result.stderr).toContain("Provide either --local or --global, not both")
  expect(await Bun.file(path.join(directory.path, "opencode.json")).exists()).toBe(false)
  expect(existsSync(path.join(directory.path, "cache/opencode/npm"))).toBe(false)
})

test("TUI-only plugins reject project scope without writing configuration", async () => {
  await using directory = await tmpdir()
  await installed(directory.path, { "./tui": "./tui.js" })
  const result = await cli(directory.path, [spec, "--local"])
  expect(result.exitCode).toBe(1)
  expect(result.stdout + result.stderr).toContain("TUI-only plugins require global CLI configuration")
  expect(await Bun.file(path.join(directory.path, "opencode.json")).exists()).toBe(false)
  expect(await Bun.file(path.join(directory.path, "config/cli.json")).exists()).toBe(false)
})

test.each(["--global", undefined])("TUI-only plugins keep global CLI configuration with %s", async (flag) => {
  await using directory = await tmpdir()
  await installed(directory.path, { "./tui": "./tui.js" })
  const result = await cli(directory.path, [spec, ...(flag ? [flag] : [])])
  expect(result.exitCode).toBe(0)
  expect(await Bun.file(path.join(directory.path, "config/cli.json")).json()).toMatchObject({
    plugins: [spec],
  })
  expect(await Bun.file(path.join(directory.path, "opencode.json")).exists()).toBe(false)
  expect(await Bun.file(path.join(directory.path, "config/opencode.json")).exists()).toBe(false)
})

test("plugins with server and TUI entrypoints can use project configuration", async () => {
  await using directory = await tmpdir()
  await installed(directory.path, { "./server": "./server.js", "./tui": "./tui.js" })
  expect(configurationTarget("server.js", "tui.js")).toBe("server")
  const result = await cli(directory.path, [spec, "--local"])
  expect(result.exitCode).toBe(0)
  expect(await Bun.file(path.join(directory.path, "opencode.json")).json()).toEqual({
    $schema: "https://opencode.ai/config.json",
    plugins: [spec],
  })
  expect(await Bun.file(path.join(directory.path, "config/cli.json")).exists()).toBe(false)
})

test("adding a plugin preserves an existing schema", async () => {
  await using directory = await tmpdir()
  const config = path.join(directory.path, "opencode.json")
  const existing = { $schema: "https://example.com/custom-schema.json", model: "test/model" }
  await Bun.write(config, JSON.stringify(existing))
  expect(await writePluginConfig(config, spec)).toBe(true)
  expect(await Bun.file(config).json()).toEqual({ ...existing, plugins: [spec] })
})

test.each([spec, { package: spec, options: { enabled: true } }])(
  "adding an already configured plugin %j does not rewrite the file",
  async (entry) => {
    await using directory = await tmpdir()
    const config = path.join(directory.path, "opencode.jsonc")
    const text = JSON.stringify({ plugins: [entry] })
    await Bun.write(config, text)
    expect(await writePluginConfig(config, spec)).toBe(false)
    expect(await Bun.file(config).text()).toBe(text)
  },
)

test.each(["{ invalid", "[]", '{"plugins": {}}'])("invalid configuration %s is not overwritten", async (text) => {
  await using directory = await tmpdir()
  const config = path.join(directory.path, "opencode.json")
  await Bun.write(config, text)
  await expect(writePluginConfig(config, spec)).rejects.toThrow("Invalid")
  expect(await Bun.file(config).text()).toBe(text)
})

async function installed(root: string, exports: Record<string, string> = { "./server": "./server.js" }) {
  const directory = path.join(
    root,
    "cache/opencode/npm",
    await Npm.cacheKey(spec),
    "1/node_modules/opencode-test-plugin",
  )
  await Bun.write(
    path.join(directory, "package.json"),
    JSON.stringify({ name: "opencode-test-plugin", version: "1.0.0", type: "module", exports }),
  )
  await Promise.all(Object.values(exports).map((file) => Bun.write(path.join(directory, file), "export default {}\n")))
}

async function cli(root: string, args: string[]) {
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "--preload",
      import.meta.resolve("@opentui/solid/preload"),
      path.join(import.meta.dir, "../src/index.ts"),
      "plugin",
      "add",
      ...args,
    ],
    {
      cwd: root,
      env: isolatedEnv(root),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}
