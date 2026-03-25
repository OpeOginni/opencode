import type { Argv, InferredOptionTypes } from "yargs"
import { Config } from "../config/config"

const options = {
  port: {
    type: "number" as const,
    describe: "port to listen on",
    default: 0,
  },
  hostname: {
    type: "string" as const,
    describe: "hostname to listen on",
    default: "127.0.0.1",
  },
  mdns: {
    type: "boolean" as const,
    describe: "enable mDNS service discovery (defaults hostname to 0.0.0.0)",
    default: false,
  },
  "mdns-domain": {
    type: "string" as const,
    describe: "custom domain name for mDNS service (default: opencode.local)",
    default: "opencode.local",
  },
  cors: {
    type: "string" as const,
    array: true,
    describe: "additional domains to allow for CORS",
    default: [] as string[],
  },
}

export type NetworkOptions = InferredOptionTypes<typeof options>

export function withNetworkOptions<T>(yargs: Argv<T>) {
  return yargs.options(options)
}

export async function resolveNetworkOptions(args: NetworkOptions) {
  const globalConfig = await Config.global()
  const customConfig = await Config.custom()

  const portExplicitlySet = process.argv.includes("--port")
  const hostnameExplicitlySet = process.argv.includes("--hostname")
  const mdnsExplicitlySet = process.argv.includes("--mdns")
  const mdnsDomainExplicitlySet = process.argv.includes("--mdns-domain")
  const corsExplicitlySet = process.argv.includes("--cors")

  const serverConfig = customConfig?.server ?? globalConfig.server // Based on Precidence Order https://opencode.ai/docs/config#precedence-order

  const mdns = mdnsExplicitlySet ? args.mdns : (serverConfig?.mdns ?? args.mdns)
  const mdnsDomain = mdnsDomainExplicitlySet ? args["mdns-domain"] : (serverConfig?.mdnsDomain ?? args["mdns-domain"])
  const port = portExplicitlySet ? args.port : (serverConfig?.port ?? args.port)
  const hostname = hostnameExplicitlySet
    ? args.hostname
    : mdns && !serverConfig?.hostname
      ? "0.0.0.0"
      : (serverConfig?.hostname ?? args.hostname)
  const configCors = serverConfig?.cors ?? []
  const argsCors = Array.isArray(args.cors) ? args.cors : args.cors ? [args.cors] : []
  const cors = [...configCors, ...argsCors]

  return { hostname, port, mdns, mdnsDomain, cors }
}
