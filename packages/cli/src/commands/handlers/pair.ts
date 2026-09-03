import { EOL } from "os"
import path from "node:path"
import { Effect, Option } from "effect"
import { Service } from "@opencode-ai/client/effect/service"
import { OpenCode } from "@opencode-ai/client/promise"
import { renderUnicodeCompact } from "uqr"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServiceConfig } from "../../services/service-config"

export default Runtime.handler(
  Commands.commands.pair,
  Effect.fn("cli.pair")(function* (input) {
    const endpoint = yield* Service.ensure(yield* ServiceConfig.options())
    const password = yield* ServiceConfig.password()
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    const server = yield* Effect.tryPromise(() => client.server.get())
    const info = { urls: server.urls, username: "opencode", password }
    const directory = path.resolve(Option.getOrElse(input.directory, () => process.cwd()))
    const remote = info.urls.find((value) => {
      const url = new URL(value)
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.hostname !== "localhost" &&
        !url.hostname.endsWith(".localhost") &&
        !url.hostname.startsWith("127.") &&
        url.hostname !== "[::1]"
      )
    })
    const pairing = remote ? yield* Effect.tryPromise(() => client.server.pairing.create()) : undefined
    const params =
      remote && pairing ? new URLSearchParams({ server: remote, ticket: pairing.ticket, directory }) : undefined
    const web = params ? `https://app.opencode.ai/#pair?${params}` : undefined
    const desktop = params ? `opencode://connect?${params}` : undefined
    process.stdout.write(
      [
        "",
        `  URLs      ${info.urls[0] ?? "(none)"}`,
        ...info.urls.slice(1).map((url) => `            ${url}`),
        `  Username  ${info.username}`,
        `  Password  ${info.password}`,
        ...(web ? [`  Web       ${web}`] : []),
        ...(desktop ? [`  Desktop   ${desktop}`] : []),
        "",
        "  Scan to pair",
        "",
        renderUnicodeCompact(JSON.stringify(info), { border: 2 })
          .split(EOL)
          .map((line) => "  " + line)
          .join(EOL),
        "",
      ].join(EOL) + EOL,
    )

    const hostname = new URL(endpoint.url).hostname
    if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) return
    process.stderr.write(`  Run \`opencode service set hostname 0.0.0.0\` to access the service remotely.${EOL}${EOL}`)
  }),
)
