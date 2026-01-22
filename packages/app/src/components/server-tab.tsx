import { createResource, createEffect, createMemo, onCleanup, Show, createSignal } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { List } from "@opencode-ai/ui/list"
import { TextField } from "@opencode-ai/ui/text-field"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Popover } from "@opencode-ai/ui/popover"
import { normalizeServerUrl, serverDisplayName, useServer } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { Component } from "solid-js"
import { DialogSelectServer } from "@/components/dialog-select-server"

type ServerStatus = { healthy: boolean; version?: string; authenticated?: boolean }

async function checkHealth(url: string, fetch?: typeof globalThis.fetch): Promise<ServerStatus> {
  const sdk = createOpencodeClient({
    baseUrl: url,
    fetch,
    signal: AbortSignal.timeout(3000),
  })
  return sdk.global
    .health()
    .then((x) => {
      const data = x.data as { healthy: boolean; version?: string; authenticated?: boolean }
      return {
        healthy: data?.healthy === true,
        version: data?.version,
        authenticated: data?.authenticated === true,
      }
    })
    .catch(() => ({ healthy: false }))
}

export const ServerTab: Component<{ onTitleChange?: (title: string, description: string) => void }> = (props) => {
  const server = useServer()
  const platform = usePlatform()
  const dialog = useDialog()
  const [store, setStore] = createStore({
    status: {} as Record<string, ServerStatus | undefined>,
  })
  const [defaultUrl, defaultUrlActions] = createResource(() => platform.getDefaultServerUrl?.())
  const isDesktop = platform.platform === "desktop"

  const items = createMemo(() => {
    const current = server.url
    const list = server.list
    if (!current) return list
    if (!list.includes(current)) return [current, ...list]
    return [current, ...list.filter((x) => x !== current)]
  })

  const current = createMemo(() => items().find((x) => x === server.url) ?? items()[0])

  const sortedItems = createMemo(() => {
    const list = items()
    if (!list.length) return list
    const active = current()
    const order = new Map(list.map((url, index) => [url, index] as const))
    const rank = (value?: ServerStatus) => {
      if (value?.healthy === true) return 0
      if (value?.healthy === false) return 2
      return 1
    }
    return list.slice().sort((a, b) => {
      if (a === active) return -1
      if (b === active) return 1
      const diff = rank(store.status[a]) - rank(store.status[b])
      if (diff !== 0) return diff
      return (order.get(a) ?? 0) - (order.get(b) ?? 0)
    })
  })
  const visibleItems = createMemo(() => sortedItems().slice(0, 4))

  async function refreshHealth() {
    const results: Record<string, ServerStatus> = {}
    await Promise.all(
      items().map(async (url) => {
        results[url] = await checkHealth(url, platform.fetch)
      }),
    )
    setStore("status", reconcile(results))
  }

  createEffect(() => {
    items()
    refreshHealth()
    const interval = setInterval(refreshHealth, 10_000)
    onCleanup(() => clearInterval(interval))
  })

  function select(value: string, persist?: boolean) {
    if (!persist && store.status[value]?.healthy === false) return
    if (persist) {
      server.add(value)
      return
    }
    server.setActive(value)
    setTimeout(() => dialog.close(), 100)
  }

  return (
    <div class="flex flex-col px-2 pb-2">
      <div class="flex flex-col p-2 bg-background-base">
        <List
          emptyMessage="No servers yet"
          items={visibleItems}
          key={(x) => x}
          current={current()}
          onSelect={(x) => {
            if (x) select(x)
          }}
        >
          {(i) => {
            return (
              <div class="flex items-center gap-2 min-w-0 flex-1 group/item">
                <div
                  class="flex items-center gap-2 min-w-0 flex-1"
                  classList={{ "opacity-50": store.status[i]?.healthy === false }}
                >
                  <div
                    classList={{
                      "size-1.5 rounded-full shrink-0": true,
                      "bg-icon-success-base": store.status[i]?.healthy === true,
                      "bg-icon-critical-base": store.status[i]?.healthy === false,
                      "bg-border-weak-base": store.status[i] === undefined,
                    }}
                  />
                  <span class="truncate">{serverDisplayName(i)}</span>
                  <span class="text-text-weak">{store.status[i]?.version}</span>
                  <Show when={isDesktop && defaultUrl() === i}>
                    <span class="text-text-weak text-12-regular">Default</span>
                  </Show>
                </div>
              </div>
            )
          }}
        </List>
        <div class="px-3">
          <Button
            variant="secondary"
            size="small"
            onClick={() => dialog.show(() => <DialogSelectServer />)}
            class="px-3 py-4"
          >
            Manage server
          </Button>
        </div>
      </div>
    </div>
  )
}
