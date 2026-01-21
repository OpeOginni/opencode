import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { createMemo, onCleanup } from "solid-js"
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

    const sdkMemo = createMemo(() => {
      // Wait for credentials to be ready before creating SDK client
      if (!credentials.ready()) return null
      return createOpencodeClient({
        baseUrl: globalSDK.url,
        fetch: platform.fetch,
        directory: props.directory,
        throwOnError: true,
        headers: headers(),
      })
    })

    const emitter = createGlobalEmitter<{
      [key in Event["type"]]: Extract<Event, { type: key }>
    }>()

    const unsub = globalSDK.event.on(props.directory, (event) => {
      emitter.emit(event.type, event)
    })
    onCleanup(unsub)

    return {
      directory: props.directory,
      get client() {
        const client = sdkMemo()
        if (!client) throw new Error("SDK client not ready - credentials not loaded")
        return client
      },
      event: emitter,
      url: globalSDK.url,
      refetchCredentials: credentials.refetch,
      get ready() {
        return credentials.ready()
      },
    }
  },
})
