import { BusEvent } from "@/bus/bus-event"
import { Log } from "../util/log"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { proxy } from "hono/proxy"
import z from "zod"
import { Provider } from "../provider/provider"
import { NamedError } from "@opencode-ai/util/error"
import { lazy } from "../util/lazy"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { websocket } from "hono/bun"

// @ts-ignore This global is needed to prevent ai-sdk from logging warnings to stdout https://github.com/vercel/ai/blob/2dc67e0ef538307f21368db32d5a12345d98831b/packages/ai/src/logger/log-warnings.ts#L85
globalThis.AI_SDK_LOG_WARNINGS = false

export namespace WebOnlyServer {
  const log = Log.create({ service: "web-only-server" })

  export const Event = {
    Connected: BusEvent.define("server.connected", z.object({})),
    Disposed: BusEvent.define("global.disposed", z.object({})),
  }

  const app = new Hono()
  export const App = (serverUrl: string) => lazy(() =>
    app
      .onError((err, c) => {
        log.error("failed", {
          error: err,
        })
        if (err instanceof NamedError) {
          let status: ContentfulStatusCode = 500
          return c.json(err.toObject(), { status })
        }
        const message = err instanceof Error && err.stack ? err.stack : err.toString()
        return c.json(new NamedError.Unknown({ message }).toObject(), {
          status: 500,
        })
      })
      .use(async (c, next) => {
        const skipLogging = c.req.path === "/log"
        if (!skipLogging) {
          log.info("request", {
            method: c.req.method,
            path: c.req.path,
          })
        }
        const timer = log.time("request", {
          method: c.req.method,
          path: c.req.path,
        })
        await next()
        if (!skipLogging) {
          timer.stop()
        }
      })
      .use(cors())
      .all("/*", async (c) => {
        log.info("NEW REQUEST", {
          path: c.req.path,
          url: serverUrl,
        })
        // Build the target URL properly
        const path = c.req.path
        const query = c.req.query()
        
        // Create target URL with path
        const targetUrl = new URL(`https://desktop.opencode.ai${path}`)
        
        // Copy existing query parameters
        for (const [key, value] of Object.entries(query)) {
          if (value) {
            targetUrl.searchParams.set(key, value)
          }
        }
        
        // Only add ?url= if it's not already present (for first render)
        if (!targetUrl.searchParams.has("url")) {
          targetUrl.searchParams.set("url", serverUrl)
        }
        
        log.info("PROXY TO", { targetUrl: targetUrl.toString() })
              
        return proxy(targetUrl.toString(), {
          ...c.req,
          headers: {
            host: "desktop.opencode.ai",
          },
        })
      }),
  )

  export function listen(opts: { port: number; hostname: string; serverUrl: string}) {
    const server = Bun.serve({
      port: opts.port,
      hostname: opts.hostname,
      idleTimeout: 0,
      fetch: App(opts.serverUrl)().fetch,
      websocket: websocket,
    })
    
    return server
  }
}
