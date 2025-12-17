import { WebOnlyServer } from "@/server/web-only"
import { Server } from "../../server/server"
import { UI } from "../ui"
import { cmd } from "./cmd"
import open from "open"
import { networkInterfaces } from "os"
import type { BunWebSocketData } from "hono/bun"

function getNetworkIPs() {
  const nets = networkInterfaces()
  const results: string[] = []

  for (const name of Object.keys(nets)) {
    const net = nets[name]
    if (!net) continue

    for (const netInfo of net) {
      // Skip internal and non-IPv4 addresses
      if (netInfo.internal || netInfo.family !== "IPv4") continue

      // Skip Docker bridge networks (typically 172.x.x.x)
      if (netInfo.address.startsWith("172.")) continue

      results.push(netInfo.address)
    }
  }

  return results
}

export const WebCommand = cmd({
  command: "web",
  builder: (yargs) =>
    yargs
      .option("port", {
        alias: ["p"],
        type: "number",
        describe: "port to listen on",
        default: 0,
      })
      .option("hostname", {
        type: "string",
        describe: "hostname to listen on",
        default: "127.0.0.1",
      })
      .option("attach", {
        type: "string",
        describe: "attach to a running opencode server (e.g., http://localhost:4096)",
      }),
  describe: "starts a headless opencode server",
  handler: async (args) => {
    const hostname = args.hostname
    const port = args.port
    const serverUrl = args.attach
    let server: Bun.Server<BunWebSocketData>

    if (serverUrl) {
      server = WebOnlyServer.listen({
        port,
        hostname,
        serverUrl
    })
    } else {
      server = Server.listen({
        port,
        hostname,
      })
    } 


    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()

    if (hostname === "0.0.0.0") {
      // Show localhost for local access
      const localhostUrl = serverUrl ? `http://localhost:${server.port}?url=${serverUrl}` : `http://localhost:${server.port}`
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Local access:      ", UI.Style.TEXT_NORMAL, localhostUrl)

      // Show network IPs for remote access
      const networkIPs = getNetworkIPs()
      if (networkIPs.length > 0) {
        for (const ip of networkIPs) {
          const networkUrl = serverUrl ? `http://${ip}:${server.port}?url=${serverUrl}` : `http://${ip}:${server.port}`
          UI.println(
            UI.Style.TEXT_INFO_BOLD + "  Network access:    ",
            UI.Style.TEXT_NORMAL,
            networkUrl,
          )
        }
      }

      // Open localhost in browser
      open(localhostUrl.toString()).catch(() => {})
    } else {
      const displayUrl = serverUrl ? `${server.url.toString()}?url=${serverUrl}` : server.url.toString()
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, displayUrl)
      open(displayUrl).catch(() => {})
    }

    await new Promise(() => {})
    await server.stop()
  },
})
