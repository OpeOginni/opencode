import { Flag } from "@/flag/flag"
import { cmd } from "../cmd"
import { tui } from "./app"

export const AttachCommand = cmd({
  command: "attach <url>",
  describe: "attach to a running opencode server",
  builder: (yargs) =>
    yargs
      .positional("url", {
        type: "string",
        describe: "http://localhost:4096",
        demandOption: true,
      })
      .option("dir", {
        type: "string",
        description: "directory to run in",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("username", {
        alias: ["u"],
        default: "opencode",
        type: "string",
        describe: "username to use",
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "password to use",
      }),
  handler: async (args) => {
    if (args.dir) process.chdir(args.dir)
    const username = args.username ?? Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
    const password = args.password ?? Flag.OPENCODE_SERVER_PASSWORD
    await tui({
      url: args.url,
      args: { sessionID: args.session, username, password },
      directory: args.dir ? process.cwd() : undefined,
    })
  },
})
