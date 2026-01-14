import { createSimpleContext } from "@opencode-ai/ui/context"
import { createMemo, createResource } from "solid-js"
import { usePlatform } from "./platform"
import { useServer } from "./server"

export const { use: useCredentials, provider: CredentialsProvider } = createSimpleContext({
  name: "Credentials",
  init: () => {
    const server = useServer()
    const platform = usePlatform()

    const getCredentials = async (url: string) => {
      if (!platform.getServerCredentials) return undefined
      console.log("getCredentials", url)
      console.log("platform.getServerCredentials", await platform.getServerCredentials(url))
      return await platform.getServerCredentials(url)
    }

    const [credentials, { refetch }] = createResource(
      () => server.url,
      async (url) => await getCredentials(url),
    )

    const headers = createMemo(() => {
      const creds = credentials()
      if (!creds) return undefined
      return {
        Authorization: `Basic ${btoa(`${creds.username}:${creds.password}`)}`,
      }
    })

    return {
      credentials: () => credentials(),
      headers,
      refetch,
    }
  },
})
