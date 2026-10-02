import { describe, expect, test } from "bun:test"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { parse } from "jsonc-parser"
import { removeMcpConfig } from "../src/commands/handlers/mcp/remove"
import { tmpdir } from "./fixture/tmpdir"

describe("mcp remove", () => {
  test.each([
    { type: "local", command: ["paper", "mcp"] },
    { type: "remote", url: "https://example.com/mcp", oauth: false, headers: { Authorization: "Bearer key" } },
    { type: "remote", url: "https://example.com/mcp" },
  ])("removes a $type server without requiring OAuth", async (server) => {
    await using directory = await tmpdir()
    const filepath = path.join(directory.path, "opencode.jsonc")
    await writeFile(
      filepath,
      `{
  // keep this comment
  "shell": "/bin/zsh",
  "mcp": {
    "timeout": { "startup": 45000 },
    "servers": {
      "paper": ${JSON.stringify(server)},
      "keep": { "type": "local", "command": ["keep"] },
    },
  },
}
`,
      { mode: 0o600 },
    )
    expect(await removeMcpConfig(filepath, "paper")).toBe(true)
    const text = await readFile(filepath, "utf8")
    expect(text).toContain("// keep this comment")
    expect(parse(text)).toEqual({
      shell: "/bin/zsh",
      mcp: { timeout: { startup: 45000 }, servers: { keep: { type: "local", command: ["keep"] } } },
    })
    if (process.platform !== "win32") expect((await stat(filepath)).mode & 0o777).toBe(0o600)
  })

  test("removes legacy and canonical definitions without touching other MCP settings", async () => {
    await using directory = await tmpdir()
    const filepath = path.join(directory.path, "opencode.json")
    const server = { type: "local", command: ["paper", "mcp"], enabled: true }
    await Bun.write(filepath, JSON.stringify({ mcp: { paper: server, servers: { paper: server, keep: server } } }))

    expect(await removeMcpConfig(filepath, "paper")).toBe(true)
    expect(await Bun.file(filepath).json()).toEqual({ mcp: { servers: { keep: server } } })
    expect(await removeMcpConfig(filepath, "paper")).toBe(false)
  })

  test("treats server names literally and preserves the servers map", async () => {
    await using directory = await tmpdir()
    const filepath = path.join(directory.path, "opencode.json")
    const server = { type: "local", command: ["paper", "mcp"] }
    await Bun.write(
      filepath,
      JSON.stringify({ mcp: { servers: { "paper.tools/one": server, servers: server, keep: server } } }),
    )

    expect(await removeMcpConfig(filepath, "paper.tools/one")).toBe(true)
    expect(await removeMcpConfig(filepath, "servers")).toBe(true)
    expect(await Bun.file(filepath).json()).toEqual({ mcp: { servers: { keep: server } } })
  })

  test.each(['{ "mcp": {', "[]", '{ "mcp": false }'])("does not rewrite invalid configuration: %s", async (text) => {
    await using directory = await tmpdir()
    const filepath = path.join(directory.path, "opencode.jsonc")
    await Bun.write(filepath, text)

    await expect(removeMcpConfig(filepath, "paper")).rejects.toThrow("Invalid")
    expect(await Bun.file(filepath).text()).toBe(text)
  })

  test("leaves absent entries and missing files unchanged", async () => {
    await using directory = await tmpdir()
    const filepath = path.join(directory.path, "opencode.jsonc")
    expect(await removeMcpConfig(filepath, "paper")).toBe(false)
    expect(await Bun.file(filepath).exists()).toBe(false)
    const text = '{\n  // untouched\n  "model": "provider/model"\n}\n'
    await Bun.write(filepath, text)
    expect(await removeMcpConfig(filepath, "paper")).toBe(false)
    expect(await Bun.file(filepath).text()).toBe(text)
  })

  test("CLI removal defaults to the current project and --global removes all global definitions", async () => {
    await using directory = await tmpdir()
    const global = path.join(directory.path, "global")
    const project = path.join(directory.path, "project")
    await Promise.all([mkdir(global), mkdir(path.join(project, ".opencode"), { recursive: true })])
    const config = JSON.stringify({ mcp: { servers: { paper: { type: "local", command: ["paper", "mcp"] } } } })
    const files = [
      path.join(global, "opencode.json"),
      path.join(global, "opencode.jsonc"),
      path.join(project, "opencode.json"),
      path.join(project, ".opencode", "opencode.jsonc"),
    ] as const
    await Promise.all(files.map((file) => Bun.write(file, config)))
    const local = await cli(["mcp", "remove", "paper"], project, directory.path)
    expect(local).toMatchObject({ exitCode: 0, stderr: "" })
    expect(local.stdout).toContain('MCP server "paper" removed from')
    expect(await Bun.file(files[0]).text()).toBe(config)
    expect(await Bun.file(files[1]).text()).toBe(config)
    expect(await Bun.file(files[2]).json()).toEqual({ mcp: { servers: {} } })
    expect(await Bun.file(files[3]).json()).toEqual({ mcp: { servers: {} } })

    await Bun.write(files[2], config)
    const shared = await cli(["mcp", "remove", "paper", "--global"], project, directory.path)
    expect(shared).toMatchObject({ exitCode: 0, stderr: "" })
    expect(shared.stdout).toContain(files[0])
    expect(shared.stdout).toContain(files[1])
    expect(await Bun.file(files[0]).json()).toEqual({ mcp: { servers: {} } })
    expect(await Bun.file(files[1]).json()).toEqual({ mcp: { servers: {} } })
    expect(await Bun.file(files[2]).text()).toBe(config)
    expect(await Bun.file(path.join(directory.path, "state", "opencode", "service-local.json")).exists()).toBe(false)

    const absent = await cli(["mcp", "remove", "paper", "--global"], project, directory.path)
    expect(absent).toMatchObject({ exitCode: 0, stderr: "" })
    expect(absent.stdout).toContain("is not configured in global configuration")
  }, 20000)

  test("adds and removes a server from the same project config", async () => {
    await using directory = await tmpdir()
    const project = path.join(directory.path, "project")
    await mkdir(path.join(project, ".opencode"), { recursive: true })
    const filepath = path.join(project, ".opencode", "opencode.jsonc")
    await Bun.write(filepath, '{\n  // keep this comment\n  "model": "provider/model"\n}\n')
    const added = await cli(["mcp", "add", "paper", "--", "paper", "mcp"], project, directory.path)
    expect(added).toMatchObject({ exitCode: 0, stderr: "" })
    expect(added.stdout).toContain(filepath)
    expect(parse(await Bun.file(filepath).text()).mcp.servers.paper).toEqual({
      type: "local",
      command: ["paper", "mcp"],
    })
    const removed = await cli(["mcp", "remove", "paper"], project, directory.path)
    expect(removed).toMatchObject({ exitCode: 0, stderr: "" })
    expect(parse(await Bun.file(filepath).text())).toEqual({ model: "provider/model", mcp: { servers: {} } })
    expect(await Bun.file(filepath).text()).toContain("// keep this comment")
  })

  test("CLI rejects malformed configuration without changing it", async () => {
    await using directory = await tmpdir()
    const filepath = path.join(directory.path, "opencode.jsonc")
    const text = '{ "mcp": { "servers": '
    await Bun.write(filepath, text)
    const result = await cli(["mcp", "remove", "paper"], directory.path, directory.path)
    expect(result.exitCode).toBe(1)
    expect(result.stdout + result.stderr).toContain("Invalid configuration")
    expect(await Bun.file(filepath).text()).toBe(text)
  })

  test("advertises removal separately from OAuth logout", async () => {
    await using directory = await tmpdir()
    const [group, help] = await Promise.all([
      cli(["mcp", "--help"], directory.path, directory.path),
      cli(["mcp", "remove", "--help"], directory.path, directory.path),
    ])
    expect(group.exitCode).toBe(0)
    expect(group.stdout).toContain("remove")
    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain("opencode mcp remove [flags] <name>")
    expect(help.stdout).toContain("--global")
    expect(help.stdout).toContain("without deleting OAuth credentials")
  })
})

async function cli(args: string[], cwd: string, root: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "--jsx-import-source=@opentui/solid",
      path.join(import.meta.dir, "../src/index.ts"),
      ...args,
    ],
    {
      cwd,
      env: {
        ...process.env,
        OPENCODE_CONFIG_DIR: path.join(root, "global"),
        XDG_STATE_HOME: path.join(root, "state"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_CACHE_HOME: path.join(root, "cache"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}
