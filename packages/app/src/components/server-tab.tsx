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

async function checkCredentials(
  url: string,
  username: string,
  password: string,
  fetch?: typeof globalThis.fetch,
): Promise<{ correctCredentials: boolean }> {
  const sdk = createOpencodeClient({
    baseUrl: url,
    fetch,
    signal: AbortSignal.timeout(3000),
    headers: {
      Authorization: `Basic ${btoa(`${username}:${password}`)}`,
    },
  })
  return sdk.config
    .get()
    .then((x) => {
      if (x?.error) return { correctCredentials: false }
      return { correctCredentials: true }
    })
    .catch(() => {
      return { correctCredentials: false }
    })
}

export const ServerTab: Component<{ onTitleChange?: (title: string, description: string) => void }> = (props) => {
  const server = useServer()
  const platform = usePlatform()
  const globalSDK = useGlobalSDK()
  const dialog = useDialog()
  const [store, setStore] = createStore({
    url: "",
    adding: false,
    error: "",
    status: {} as Record<string, ServerStatus | undefined>,
    showCredentials: false,
    credentialsUrl: "",
    username: "",
    password: "",
    credentialsError: "",
    showAddServerForm: false,
    addingStatus: undefined as "success" | "error" | undefined,
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

  createEffect(() => {
    if (props.onTitleChange) {
      const title = store.showCredentials ? "Enter credentials" : "Servers"
      const description = store.showCredentials
        ? `Connect to ${serverDisplayName(store.credentialsUrl)}`
        : "Switch which OpenCode server this app connects to."
      props.onTitleChange(title, description)
    }
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

  async function handleSaveServer(e: SubmitEvent) {
    e.preventDefault()
    const value = normalizeServerUrl(store.url)
    if (!value) return

    setStore("adding", true)
    setStore("error", "")
    setStore("addingStatus", undefined)

    const result = await checkHealth(value, platform.fetch)
    setStore("adding", false)

    if (!result.healthy) {
      setStore("error", "Could not connect to server")
      setStore("addingStatus", "error")
      return
    }

    setStore("addingStatus", "success")

    if (result.authenticated) {
      setStore("credentialsUrl", value)
      setStore("showCredentials", true)
      setStore("username", "opencode")
      setStore("password", "")
      setStore("credentialsError", "")
      return
    }

    setStore("url", "")
    setStore("showAddServerForm", false)
    select(value, true)
    setTimeout(() => dialog.close(), 100)
  }

  async function handleCredentialsSubmit(e: SubmitEvent) {
    e.preventDefault()
    const url = store.credentialsUrl
    if (!url || !store.username || !store.password) {
      setStore("credentialsError", "Username and password are required")
      return
    }

    setStore("credentialsError", "")
    setStore("adding", true)

    const result = await checkCredentials(url, store.username, store.password, platform.fetch)
    setStore("adding", false)

    if (!result.correctCredentials) {
      setStore("credentialsError", "Invalid username or password")
      return
    }

    await platform.storeServerCredentials?.(url, store.username, store.password)
    await globalSDK.refetchCredentials()

    setStore("showCredentials", false)
    setStore("url", "")
    setStore("showAddServerForm", false)
    select(url, true)
    setTimeout(() => dialog.close(), 100)
  }

  function handleCancelCredentials() {
    setStore("showCredentials", false)
    setStore("credentialsUrl", "")
    setStore("username", "")
    setStore("password", "")
    setStore("credentialsError", "")
  }

  async function handleRemove(url: string) {
    server.remove(url)
    await platform.removeServerCredentials?.(url)
  }

  return (
    <Show
      when={store.showCredentials}
      fallback={
        <div class="flex flex-col gap-4 pb-6 pt-4 min-h-[150px]">
          <List
            search={{ placeholder: "Search servers", autofocus: true }}
            emptyMessage="No servers yet"
            items={sortedItems}
            key={(x) => x}
            current={current()}
            onSelect={(x) => {
              if (x) select(x)
            }}
          >
            {(i) => {
              const [popoverOpen, setPopoverOpen] = createSignal(false)
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
                    <Show when={store.status[i]?.authenticated === true}>
                      <span class="text-text-weak text-12-regular">Authed</span>
                    </Show>
                    <span class="text-text-weak">{store.status[i]?.version}</span>
                    <Show when={defaultUrl() === i}>
                      <span class="text-text-weak text-12-regular">Default</span>
                    </Show>
                  </div>
                  <Show when={current() !== i && server.list.includes(i)}>
                    <div onClick={(e) => e.stopPropagation()}>
                      <Popover
                        open={popoverOpen()}
                        onOpenChange={setPopoverOpen}
                        trigger={
                          <IconButton
                            icon="dot-grid"
                            variant="ghost"
                            class="bg-transparent transition-opacity shrink-0 hover:scale-110"
                          />
                        }
                        class="min-w-[150px]"
                      >
                        <div class="flex flex-col gap-1">
                          <Button
                            variant="ghost"
                            size="normal"
                            class="w-full justify-start text-md"
                            onClick={(e: MouseEvent) => {
                              e.stopPropagation()
                              setPopoverOpen(false)
                              // TODO: Implement edit functionality
                            }}
                          >
                            Edit
                          </Button>
                          <Show when={isDesktop}>
                            <Button
                              variant="ghost"
                              size="normal"
                              class="w-full justify-start text-md"
                              onClick={async (e: MouseEvent) => {
                                e.stopPropagation()
                                setPopoverOpen(false)
                                await platform.setDefaultServerUrl?.(i)
                                defaultUrlActions.refetch(i)
                              }}
                            >
                              Set as default
                            </Button>
                          </Show>
                          <div class="h-px bg-border-weak-base my-1" />
                          <Button
                            variant="ghost"
                            size="normal"
                            class="w-full justify-start text-md text-text-on-critical-base hover:bg-surface-critical-weak"
                            onClick={(e: MouseEvent) => {
                              e.stopPropagation()
                              setPopoverOpen(false)
                              handleRemove(i)
                            }}
                          >
                            Delete
                          </Button>
                        </div>
                      </Popover>
                    </div>
                  </Show>
                </div>
              )
            }}
          </List>

          <Show
            when={store.showAddServerForm}
            fallback={
              <div class="px-6 pt-2">
                <Button
                  variant="secondary"
                  icon="plus-small"
                  size="large"
                  onClick={() => setStore("showAddServerForm", true)}
                  class="px-3 py-4"
                >
                  Add server
                </Button>
              </div>
            }
          >
            <div class="px-5 pt-2">
              <form onSubmit={handleSaveServer} class="flex flex-col gap-4">
                <div class="flex items-center gap-2">
                  <div
                    class="size-1.5 rounded-full shrink-0"
                    classList={{
                      "bg-icon-success-base": store.addingStatus === "success",
                      "bg-icon-critical-base": store.addingStatus === "error",
                      "bg-border-weak-base": !store.addingStatus,
                    }}
                  />
                  <TextField
                    type="text"
                    label="Server URL"
                    hideLabel
                    placeholder="http://localhost:4096"
                    value={store.url}
                    onChange={(v) => {
                      setStore("url", v)
                      setStore("error", "")
                    }}
                    validationState={store.error ? "invalid" : "valid"}
                    error={store.error}
                    autofocus
                    class="w-full"
                  />
                </div>

                <div class="flex items-center gap-2">
                  <Button type="submit" variant="primary" size="large" disabled={store.adding} class="px-3 py-4">
                    {store.adding ? "Saving..." : "Save"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="large"
                    class="px-3 py-4"
                    onClick={() => {
                      setStore("showAddServerForm", false)
                      setStore("url", "")
                      setStore("error", "")
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            </div>
          </Show>

          {/* <Show when={isDesktop}>
            <div class="px-6 pt-2 flex flex-col gap-1.5">
              <div class="px-3">
                <h3 class="text-14-regular text-text-weak">Default server</h3>
                <p class="text-12-regular text-text-weak mt-1">
                  Connect to this server on app launch instead of starting a local server. Requires restart.
                </p>
              </div>
              <div class="flex items-center gap-2 px-3 py-2">
                <Show
                  when={defaultUrl()}
                  fallback={
                    <Show
                      when={server.url}
                      fallback={<span class="text-14-regular text-text-weak">No server selected</span>}
                    >
                      <Button
                        variant="secondary"
                        size="small"
                        onClick={async () => {
                          await platform.setDefaultServerUrl?.(server.url)
                          defaultUrlActions.refetch(server.url)
                        }}
                      >
                        Set current server as default
                      </Button>
                    </Show>
                  }
                >
                  <div class="flex items-center gap-2 flex-1 min-w-0">
                    <span class="truncate text-14-regular">{serverDisplayName(defaultUrl()!)}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="small"
                    onClick={async () => {
                      await platform.setDefaultServerUrl?.(null)
                      defaultUrlActions.refetch()
                    }}
                  >
                    Clear
                  </Button>
                </Show>
              </div>
            </div>
          </Show> */}
        </div>
      }
    >
      <div class="flex flex-col justify-center items-center gap-6 pb-6 px-4">
        <form onSubmit={handleCredentialsSubmit} class="w-full max-w-sm bg-bg-subtle rounded-lg shadow-lg p-6">
          <div class="flex flex-col gap-5">
            <TextField
              type="text"
              label="Username"
              placeholder="Enter username"
              value={store.username}
              onChange={(v) => {
                setStore("username", v)
                setStore("credentialsError", "")
              }}
              autofocus
              class="w-full"
              inputClass="w-full"
            />
            <TextField
              type="password"
              label="Password"
              placeholder="Enter password"
              value={store.password}
              onChange={(v) => {
                setStore("password", v)
                setStore("credentialsError", "")
              }}
              validationState={store.credentialsError ? "invalid" : "valid"}
              error={store.credentialsError}
              class="w-full"
              inputClass="w-full"
            />
            <div class="flex items-center gap-3 mt-2">
              <Button type="submit" variant="primary" size="large" disabled={store.adding} class="flex-1 min-w-[6rem]">
                {store.adding ? "Connecting..." : "Connect"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="large"
                onClick={handleCancelCredentials}
                disabled={store.adding}
                class="flex-1 min-w-[6rem]"
              >
                Back
              </Button>
            </div>
          </div>
        </form>
      </div>
    </Show>
  )
}
