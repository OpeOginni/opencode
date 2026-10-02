import { EOL } from "node:os"
import { readFile, writeFile } from "node:fs/promises"
import { Effect } from "effect"
import { applyEdits, findNodeAtLocation, modify, parseTree, type ParseError } from "jsonc-parser"
import { Global } from "@opencode/util/global"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { configPaths } from "./config"

export default Runtime.handler(
  Commands.commands.mcp.commands.remove,
  Effect.fn("cli.mcp.remove")(function* (input) {
    const global = yield* Global.Service
    const paths = configPaths(input.global ? global.config : process.cwd())
    // Both documents merge at runtime, so remove every definition in the selected scope.
    const removed = yield* Effect.forEach(input.global ? paths.slice(0, 2) : paths, (filepath) =>
      Effect.tryPromise(() => removeMcpConfig(filepath, input.name)).pipe(
        Effect.map((removed) => (removed ? [filepath] : [])),
      ),
    ).pipe(Effect.map((files) => files.flat()))
    process.stdout.write(
      removed.length
        ? `MCP server "${input.name}" removed from ${removed.join(", ")}${EOL}`
        : `MCP server "${input.name}" is not configured in ${input.global ? "global" : "project"} configuration${EOL}`,
    )
  }),
)

export async function removeMcpConfig(filepath: string, name: string) {
  const text = await readFile(filepath, "utf8").catch((error) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (text === undefined) return false
  const errors: ParseError[] = []
  const root = parseTree(text, errors, { allowTrailingComma: true })
  if (errors.length || root?.type !== "object") throw new Error(`Invalid configuration: ${filepath}`)
  const mcp = findNodeAtLocation(root, ["mcp"])
  if (mcp && mcp.type !== "object") throw new Error(`Invalid MCP configuration: ${filepath}`)

  // Remove V1-compatible entries too, without mistaking the V2 servers map for a server named "servers".
  const legacy = findNodeAtLocation(root, ["mcp", name, "type"])?.value
  const paths = [
    ...(findNodeAtLocation(root, ["mcp", "servers", name]) ? [["mcp", "servers", name]] : []),
    ...(legacy === "local" || legacy === "remote" ? [["mcp", name]] : []),
  ]
  if (!paths.length) return false
  const updated = paths.reduce(
    (content, path) =>
      applyEdits(
        content,
        modify(content, path, undefined, {
          formattingOptions: { tabSize: 2, insertSpaces: true },
        }),
      ),
    text,
  )
  await writeFile(filepath, updated)
  return true
}
