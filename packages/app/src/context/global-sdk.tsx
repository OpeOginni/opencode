import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, createMemo, createResource, onCleanup } from "solid-js"
import { usePlatform } from "./platform"
import { useServer } from "./server"

export const { use: useGlobalSDK, provider: GlobalSDKProvider } = createSimpleContext({
  name: "GlobalSDK",
  init: () => {
    const server = useServer()
    const platform = usePlatform()
    const abort = new AbortController()

    const [credentials, { refetch: refetchCredentials }] = createResource(
      () => server.url,
      async (url) => {
        if (!platform.getServerCredentials) return null
        return await platform.getServerCredentials(url)
      },
    )

    const headers = createMemo(() => {
      const creds = credentials()
      if (!creds) return undefined
      return {
        Authorization: `Basic ${btoa(`${creds.username}:${creds.password}`)}`,
      }
    })

    const eventSdkMemo = createMemo(() => {
      // Wait for credentials to be ready before creating SDK client
      const credsState = credentials.state
      if (credsState !== "ready") return null
      return createOpencodeClient({
        baseUrl: server.url,
        signal: abort.signal,
        fetch: platform.fetch,
        headers: headers(),
      })
    })

    const emitter = createGlobalEmitter<{
      [key: string]: Event
    }>()

    type Queued = { directory: string; payload: Event }

    let queue: Array<Queued | undefined> = []
    const coalesced = new Map<string, number>()
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = 0

    const key = (directory: string, payload: Event) => {
      if (payload.type === "session.status") return `session.status:${directory}:${payload.properties.sessionID}`
      if (payload.type === "lsp.updated") return `lsp.updated:${directory}`
      if (payload.type === "message.part.updated") {
        const part = payload.properties.part
        return `message.part.updated:${directory}:${part.messageID}:${part.id}`
      }
    }

    const flush = () => {
      if (timer) clearTimeout(timer)
      timer = undefined

      const events = queue
      queue = []
      coalesced.clear()
      if (events.length === 0) return

      last = Date.now()
      batch(() => {
        for (const event of events) {
          if (!event) continue
          emitter.emit(event.directory, event.payload)
        }
      })
    }

    const schedule = () => {
      if (timer) return
      const elapsed = Date.now() - last
      timer = setTimeout(flush, Math.max(0, 16 - elapsed))
    }

    const stop = () => {
      flush()
    }

    void (async () => {
      const eventSdk = eventSdkMemo()
      if (!eventSdk) return
      const events = await eventSdk.global.event()
      let yielded = Date.now()
      for await (const event of events.stream) {
        const directory = event.directory ?? "global"
        const payload = event.payload
        const k = key(directory, payload)
        if (k) {
          const i = coalesced.get(k)
          if (i !== undefined) {
            queue[i] = undefined
          }
          coalesced.set(k, queue.length)
        }
        queue.push({ directory, payload })
        schedule()

        if (Date.now() - yielded < 8) continue
        yielded = Date.now()
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }
    })()
      .finally(stop)
      .catch(() => undefined)

    onCleanup(() => {
      abort.abort()
      stop()
    })

    const sdkMemo = createMemo(() => {
      // Wait for credentials to be ready before creating SDK client
      const credsState = credentials.state
      if (credsState !== "ready") return null
      return createOpencodeClient({
        baseUrl: server.url,
        fetch: platform.fetch,
        throwOnError: true,
        headers: headers(),
      })
    })

    return {
      url: server.url,
      get client() {
        const client = sdkMemo()
        if (!client) throw new Error("SDK client not ready - credentials not loaded")
        return client
      },
      event: emitter,
      refetchCredentials,
      get ready() {
        return credentials.state === "ready"
      },
    }
  },
})
