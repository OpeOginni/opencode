import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { usePlatform } from "./platform"
import { useServer } from "./server"

export const { use: useGlobalSDK, provider: GlobalSDKProvider } = createSimpleContext({
  name: "GlobalSDK",
  init: () => {
    const server = useServer()
    const platform = usePlatform()

    type Credentials = { username: string; password: string }

    const [creds, setCreds] = createSignal<Credentials | null>(null)
    const [authReady, setAuthReady] = createSignal(false)
    const getter = platform.getServerCredentials
    const canAuth = () => platform.platform === "desktop" && !!getter

    createEffect(() => {
      const url = server.url
      if (!url) {
        setCreds(null)
        setAuthReady(true)
        return
      }
      if (!canAuth()) {
        setCreds(null)
        setAuthReady(true)
        return
      }

      const alive = { value: true }
      setAuthReady(false)
      void getter!(url)
        .then((next) => {
          if (!alive.value) return
          setCreds(next)
          setAuthReady(true)
        })
        .catch(() => {
          if (!alive.value) return
          setCreds(null)
          setAuthReady(true)
        })

      onCleanup(() => {
        alive.value = false
      })
    })

    const headers = createMemo(() => {
      const info = creds()
      if (!info) return
      return { Authorization: `Basic ${btoa(`${info.username}:${info.password}`)}` }
    })

    const refreshCredentials = (input?: string) => {
      const url = input ?? server.url
      if (!url) return
      if (url !== server.url) return
      if (!getter) return
      void getter(url)
        .then((next) => setCreds(next))
        .catch(() => setCreds(null))
    }

    const emitter = createGlobalEmitter<{
      [key: string]: Event
    }>()

    type Queued = { directory: string; payload: Event }

    let queue: Array<Queued | undefined> = []
    let buffer: Array<Queued | undefined> = []
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

      if (queue.length === 0) return

      const events = queue
      queue = buffer
      buffer = events
      queue.length = 0
      coalesced.clear()

      last = Date.now()
      batch(() => {
        for (const event of events) {
          if (!event) continue
          emitter.emit(event.directory, event.payload)
        }
      })

      buffer.length = 0
    }

    const schedule = () => {
      if (timer) return
      const elapsed = Date.now() - last
      timer = setTimeout(flush, Math.max(0, 16 - elapsed))
    }

    createEffect(() => {
      const url = server.url
      const auth = headers()
      if (!url) return
      if (canAuth() && !authReady()) return
      queue.length = 0
      buffer.length = 0
      coalesced.clear()
      last = 0
      const controller = new AbortController()
      const eventSdk = createOpencodeClient({
        baseUrl: url,
        signal: controller.signal,
        fetch: platform.fetch,
        headers: auth,
      })

      void (async () => {
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
        .finally(flush)
        .catch(() => undefined)

      onCleanup(() => {
        controller.abort()
        flush()
      })
    })

    const sdk = createMemo(() =>
      createOpencodeClient({
        baseUrl: server.url,
        fetch: platform.fetch,
        headers: headers(),
        throwOnError: true,
      }),
    )

    return {
      url: server.url,
      get client() {
        return sdk()
      },
      event: emitter,
      headers: headers,
      refreshCredentials,
      authReady,
    }
  },
})
