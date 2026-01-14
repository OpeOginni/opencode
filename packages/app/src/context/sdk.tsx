import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { createMemo, createResource, onCleanup } from "solid-js"
import { useGlobalSDK } from "./global-sdk"
import { usePlatform } from "./platform"

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: { directory: string }) => {
    const platform = usePlatform()
    const globalSDK = useGlobalSDK()

    const [credentials, { refetch: refetchCredentials }] = createResource(
      () => globalSDK.url,
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

    const sdkMemo = createMemo(() => {
      // Wait for credentials to be ready before creating SDK client
      const credsState = credentials.state
      if (credsState !== "ready") return null
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
      refetchCredentials,
      get ready() {
        return credentials.state === "ready"
      },
    }
  },
})
