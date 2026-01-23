import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { createEffect, createMemo, onCleanup } from "solid-js"
import { useGlobalSDK } from "./global-sdk"
import { usePlatform } from "./platform"
import { useCredentials } from "./credentials"

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: { directory: string }) => {
    const platform = usePlatform()
    const globalSDK = useGlobalSDK()

    const credentials = useCredentials()

    const headers = createMemo(() => {
      return credentials.headers()
    })

    const directory = createMemo(() => props.directory)
    const client = createMemo(() => {
      // Wait for credentials to be ready before creating SDK client
      if (!credentials.ready()) {
        return createOpencodeClient({
          baseUrl: globalSDK.url,
          fetch: platform.fetch,
          directory: directory(),
          throwOnError: true,
        })
      }

      return createOpencodeClient({
        baseUrl: globalSDK.url,
        fetch: platform.fetch,
        directory: directory(),
        throwOnError: true,
        headers: headers(),
      })
    })

    const emitter = createGlobalEmitter<{
      [key in Event["type"]]: Extract<Event, { type: key }>
    }>()

    createEffect(() => {
      const unsub = globalSDK.event.on(directory(), (event) => {
        emitter.emit(event.type, event)
      })
      onCleanup(unsub)
    })

    return {
      refetchCredentials: credentials.refetch,
      get ready() {
        return credentials.ready()
      },
      get directory() {
        return directory()
      },
      get client() {
        return client()
      },
      event: emitter,
      get url() {
        return globalSDK.url
      },
    }
  },
})
