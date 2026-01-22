import { createResource, createEffect, createMemo, onCleanup, Show, createSignal } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TextField } from "@opencode-ai/ui/text-field"
import { normalizeServerUrl, serverDisplayName, useServer } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { useNavigate } from "@solidjs/router"
import { useLanguage } from "@/context/language"
import { Popover } from "@opencode-ai/ui/popover"
import { useGlobalSDK } from "@/context/global-sdk"
import { ServerCredentials } from "@/components/server-credentials"

type ServerStatus = { healthy: boolean; version?: string; authenticated?: boolean }

interface AddRowProps {
  value: string
  placeholder: string
  adding: boolean
  error: string
  status: boolean | undefined
  onChange: (value: string) => void
  onKeyDown: (event: KeyboardEvent) => void
  onBlur: () => void
}

interface EditRowProps {
  value: string
  placeholder: string
  busy: boolean
  error: string
  status: boolean | undefined
  onChange: (value: string) => void
  onKeyDown: (event: KeyboardEvent) => void
  onBlur: () => void
}

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

function AddRow(props: AddRowProps) {
  return (
    <div class="flex items-center gap-3 px-4 min-w-0 flex-1">
      <div
        classList={{
          "size-1.5 rounded-full shrink-0": true,
          "bg-icon-success-base": props.status === true,
          "bg-icon-critical-base": props.status === false,
          "bg-border-weak-base": props.status === undefined,
        }}
      />
      <div class="flex-1 min-w-0">
        <TextField
          type="text"
          hideLabel
          placeholder={props.placeholder}
          value={props.value}
          autofocus
          validationState={props.error ? "invalid" : "valid"}
          error={props.error}
          disabled={props.adding}
          onChange={props.onChange}
          onKeyDown={props.onKeyDown}
          onBlur={props.onBlur}
        />
      </div>
    </div>
  )
}

function EditRow(props: EditRowProps) {
  return (
    <div class="flex items-center gap-3 px-4 min-w-0 flex-1" onClick={(event) => event.stopPropagation()}>
      <div
        classList={{
          "size-1.5 rounded-full shrink-0": true,
          "bg-icon-success-base": props.status === true,
          "bg-icon-critical-base": props.status === false,
          "bg-border-weak-base": props.status === undefined,
        }}
      />
      <div class="flex-1 min-w-0">
        <TextField
          type="text"
          hideLabel
          placeholder={props.placeholder}
          value={props.value}
          autofocus
          validationState={props.error ? "invalid" : "valid"}
          error={props.error}
          disabled={props.busy}
          onChange={props.onChange}
          onKeyDown={props.onKeyDown}
          onBlur={props.onBlur}
        />
      </div>
    </div>
  )
}

export function DialogSelectServer() {
  const navigate = useNavigate()
  const dialog = useDialog()
  const server = useServer()
  const platform = usePlatform()
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const [store, setStore] = createStore({
    status: {} as Record<string, ServerStatus | undefined>,
    addServer: {
      url: "",
      adding: false,
      error: "",
      showForm: false,
      status: undefined as boolean | undefined,
    },
    editServer: {
      id: undefined as string | undefined,
      value: "",
      error: "",
      busy: false,
      status: undefined as boolean | undefined,
    },
    serverCred: {
      show: false,
      url: "",
      mode: undefined as "select" | "add" | "edit" | undefined,
      original: "",
      username: "",
      password: "",
      error: "",
      busy: false,
    },
  })
  const [defaultUrl, defaultUrlActions] = createResource(() => platform.getDefaultServerUrl?.())
  const isDesktop = platform.platform === "desktop"

  const looksComplete = (value: string) => {
    const normalized = normalizeServerUrl(value)
    if (!normalized) return false
    const host = normalized.replace(/^https?:\/\//, "").split("/")[0]
    if (!host) return false
    if (host.includes("localhost") || host.startsWith("127.0.0.1")) return true
    return host.includes(".") || host.includes(":")
  }

  const previewStatus = async (value: string, setStatus: (value: boolean | undefined) => void) => {
    setStatus(undefined)
    if (!looksComplete(value)) return
    const normalized = normalizeServerUrl(value)
    if (!normalized) return
    const result = await checkHealth(normalized, platform.fetch)
    setStatus(result.healthy)
  }

  const resetAdd = () => {
    setStore("addServer", "url", "")
    setStore("addServer", "error", "")
    setStore("addServer", "showForm", false)
    setStore("addServer", "status", undefined)
  }

  const resetEdit = () => {
    setStore("editServer", "id", undefined)
    setStore("editServer", "value", "")
    setStore("editServer", "error", "")
    setStore("editServer", "status", undefined)
    setStore("editServer", "busy", false)
  }

  const dialogTitle = () =>
    store.serverCred.show ? language.t("dialog.server.credentials.title") : language.t("dialog.server.title")

  const dialogDescription = () =>
    store.serverCred.show
      ? language.t("dialog.server.credentials.description", { url: serverDisplayName(store.serverCred.url) })
      : null

  const canStoreCredentials = () => !!platform.storeServerCredentials && !!platform.getServerCredentials

  const needsCredentials = async (url: string, authenticated?: boolean) => {
    if (!authenticated) return false
    if (!canStoreCredentials()) return false
    const credentials = await platform.getServerCredentials?.(url)
    return !credentials
  }

  const storedCredentialsInvalid = async (url: string, authenticated?: boolean) => {
    if (!authenticated) return false
    if (!canStoreCredentials()) return false
    const credentials = await platform.getServerCredentials?.(url)
    if (!credentials) return false
    const result = await checkCredentials(url, credentials.username, credentials.password, platform.fetch)
    return !result.correctCredentials
  }

  const startCredentials = (url: string, mode: "select" | "add" | "edit", original?: string) => {
    setStore("serverCred", "show", true)
    setStore("serverCred", "url", url)
    setStore("serverCred", "mode", mode)
    setStore("serverCred", "original", original ?? "")
    setStore("serverCred", "username", "opencode")
    setStore("serverCred", "password", "")
    setStore("serverCred", "error", "")
    setStore("serverCred", "busy", false)
  }

  const stopCredentials = () => {
    setStore("serverCred", "show", false)
    setStore("serverCred", "url", "")
    setStore("serverCred", "mode", undefined)
    setStore("serverCred", "original", "")
    setStore("serverCred", "username", "")
    setStore("serverCred", "password", "")
    setStore("serverCred", "error", "")
    setStore("serverCred", "busy", false)
  }

  const replaceServer = (original: string, next: string) => {
    const active = server.url
    server.add(next)
    if (active && active !== original) server.setActive(active)
    server.remove(original)
  }

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

  async function select(value: string, persist?: boolean) {
    if (!persist && store.status[value]?.healthy === false) return
    const requiresCredentials = await needsCredentials(value, store.status[value]?.authenticated)
    if (requiresCredentials) {
      startCredentials(value, persist ? "add" : "select")
      return
    }
    const invalidCredentials = await storedCredentialsInvalid(value, store.status[value]?.authenticated)
    if (invalidCredentials) {
      startCredentials(value, persist ? "add" : "select")
      return
    }
    dialog.close()
    if (persist) {
      server.add(value)
      navigate("/")
      return
    }
    server.setActive(value)
    navigate("/")
  }

  const handleAddChange = (value: string) => {
    if (store.addServer.adding) return
    setStore("addServer", "url", value)
    setStore("addServer", "error", "")
    void previewStatus(value, (next) => setStore("addServer", "status", next))
  }

  const handleEditChange = (value: string) => {
    if (store.editServer.busy) return
    setStore("editServer", "value", value)
    setStore("editServer", "error", "")
    void previewStatus(value, (next) => setStore("editServer", "status", next))
  }

  async function handleAdd(value: string) {
    if (store.addServer.adding) return
    const normalized = normalizeServerUrl(value)
    if (!normalized) {
      resetAdd()
      return
    }

    setStore("addServer", "adding", true)
    setStore("addServer", "error", "")

    const result = await checkHealth(normalized, platform.fetch)
    setStore("addServer", "adding", false)

    if (!result.healthy) {
      setStore("addServer", "error", language.t("dialog.server.add.error"))
      return
    }

    if (await needsCredentials(normalized, result.authenticated)) {
      startCredentials(normalized, "add")
      return
    }

    resetAdd()
    await select(normalized, true)
  }

  async function handleEdit(original: string, value: string) {
    if (store.editServer.busy) return
    const normalized = normalizeServerUrl(value)
    if (!normalized) {
      resetEdit()
      return
    }

    if (normalized === original) {
      resetEdit()
      return
    }

    setStore("editServer", "busy", true)
    setStore("editServer", "error", "")

    const result = await checkHealth(normalized, platform.fetch)
    setStore("editServer", "busy", false)

    if (!result.healthy) {
      setStore("editServer", "error", language.t("dialog.server.add.error"))
      return
    }

    if (await needsCredentials(normalized, result.authenticated)) {
      resetEdit()
      startCredentials(normalized, "edit", original)
      return
    }

    replaceServer(original, normalized)

    resetEdit()
  }

  const handleAddKey = (event: KeyboardEvent) => {
    event.stopPropagation()
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    handleAdd(store.addServer.url)
  }

  const blurAdd = () => {
    if (!store.addServer.url.trim()) {
      resetAdd()
      return
    }
    handleAdd(store.addServer.url)
  }

  const handleEditKey = (event: KeyboardEvent, original: string) => {
    event.stopPropagation()
    if (event.key === "Escape") {
      event.preventDefault()
      resetEdit()
      return
    }
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    handleEdit(original, store.editServer.value)
  }

  async function handleCredentialsSubmit(e: SubmitEvent) {
    e.preventDefault()
    const url = store.serverCred.url
    if (!url || !store.serverCred.username || !store.serverCred.password) {
      setStore("serverCred", "error", language.t("dialog.server.credentials.error.required"))
      return
    }

    setStore("serverCred", "error", "")
    setStore("serverCred", "busy", true)

    const result = await checkCredentials(url, store.serverCred.username, store.serverCred.password, platform.fetch)
    setStore("serverCred", "busy", false)

    if (!result.correctCredentials) {
      setStore("serverCred", "error", language.t("dialog.server.credentials.error.invalid"))
      return
    }

    await platform.storeServerCredentials?.(url, store.serverCred.username, store.serverCred.password)
    await globalSDK.refetchCredentials()

    const mode = store.serverCred.mode
    const original = store.serverCred.original
    stopCredentials()

    if (mode === "edit" && original) {
      replaceServer(original, url)
      return
    }

    if (mode === "add") {
      resetAdd()
      await select(url, true)
      return
    }

    await select(url)
  }

  function handleCancelCredentials() {
    const mode = store.serverCred.mode
    stopCredentials()
    if (mode === "add") {
      setStore("addServer", "showForm", true)
    }
  }

  async function handleRemove(url: string) {
    server.remove(url)
    await platform.removeServerCredentials?.(url)
  }

  return (
    <Dialog title={dialogTitle()} description={dialogDescription()}>
      <Show
        when={store.serverCred.show}
        fallback={
          <div class="flex flex-col gap-2 pb-4">
            <List
              search={{ placeholder: language.t("dialog.server.search.placeholder"), autofocus: true }}
              emptyMessage={language.t("dialog.server.empty")}
              items={sortedItems}
              key={(x) => x}
              onSelect={(x) => {
                if (x) select(x)
              }}
              divider={true}
              class="[&_[data-slot=list-items]]:bg-surface-raised-base [&_[data-slot=list-items]]:rounded-md [&_[data-slot=list-item]]:py-3"
              add={
                store.addServer.showForm
                  ? {
                      render: () => (
                        <AddRow
                          value={store.addServer.url}
                          placeholder={language.t("dialog.server.add.placeholder")}
                          adding={store.addServer.adding}
                          error={store.addServer.error}
                          status={store.addServer.status}
                          onChange={handleAddChange}
                          onKeyDown={handleAddKey}
                          onBlur={blurAdd}
                        />
                      ),
                    }
                  : undefined
              }
            >
              {(i) => {
                const [popoverOpen, setPopoverOpen] = createSignal(false)
                return (
                  <div class="flex items-center gap-3 min-w-0 flex-1 group/item">
                    <Show
                      when={store.editServer.id !== i}
                      fallback={
                        <EditRow
                          value={store.editServer.value}
                          placeholder={language.t("dialog.server.add.placeholder")}
                          busy={store.editServer.busy}
                          error={store.editServer.error}
                          status={store.editServer.status}
                          onChange={handleEditChange}
                          onKeyDown={(event) => handleEditKey(event, i)}
                          onBlur={() => handleEdit(i, store.editServer.value)}
                        />
                      }
                    >
                      <div
                        class="flex items-center gap-3 px-4 min-w-0 flex-1"
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
                        <span class="text-text-weak text-14-regular">{store.status[i]?.version}</span>
                        <Show when={defaultUrl() === i}>
                          <span class="text-text-weak text-12-regular">
                            {language.t("dialog.server.status.default")}
                          </span>
                        </Show>
                      </div>
                    </Show>
                    <Show when={store.editServer.id !== i}>
                      <div class="flex items-center justify-center gap-5 px-4">
                        <Show when={current() === i}>
                          <p class="text-text-weak text-12-regular">{language.t("dialog.server.current")}</p>
                        </Show>

                        <div onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
                          <Popover
                            open={popoverOpen()}
                            onOpenChange={setPopoverOpen}
                            placement="bottom-start"
                            trigger={
                              <IconButton
                                icon="dot-grid"
                                variant="ghost"
                                class="bg-transparent transition-opacity shrink-0 hover:scale-110 size-8"
                                onPointerDown={(event: PointerEvent) => event.stopPropagation()}
                              />
                            }
                            class="w-max !min-w-fit !max-w-none"
                          >
                            <div class="flex flex-col gap-1">
                              <Button
                                variant="ghost"
                                size="normal"
                                class="justify-start text-md"
                                onClick={(e: MouseEvent) => {
                                  e.stopPropagation()
                                  setPopoverOpen(false)
                                  setStore("editServer", "id", i)
                                  setStore("editServer", "value", i)
                                  setStore("editServer", "error", "")
                                  setStore("editServer", "status", store.status[i]?.healthy)
                                }}
                              >
                                {language.t("dialog.server.menu.edit")}
                              </Button>
                              <Show when={isDesktop}>
                                <Button
                                  variant="ghost"
                                  size="normal"
                                  class="justify-start text-md"
                                  onClick={async (e: MouseEvent) => {
                                    e.stopPropagation()
                                    setPopoverOpen(false)
                                    await platform.setDefaultServerUrl?.(i)
                                    defaultUrlActions.refetch(i)
                                  }}
                                >
                                  {language.t("dialog.server.menu.default")}
                                </Button>
                              </Show>
                              <div class="h-px bg-border-weak-base my-1" />
                              <Button
                                variant="ghost"
                                size="normal"
                                class="justify-start text-md text-text-on-critical-base hover:bg-surface-critical-weak"
                                onClick={(e: MouseEvent) => {
                                  e.stopPropagation()
                                  setPopoverOpen(false)
                                  handleRemove(i)
                                }}
                              >
                                {language.t("dialog.server.menu.delete")}
                              </Button>
                            </div>
                          </Popover>
                        </div>
                      </div>
                    </Show>
                  </div>
                )
              }}
            </List>

            <div class="px-6">
              <Button
                variant="secondary"
                icon="plus-small"
                size="large"
                onClick={() => {
                  setStore("addServer", "showForm", true)
                  setStore("addServer", "url", "")
                  setStore("addServer", "error", "")
                }}
                class="px-3 py-4"
              >
                {store.addServer.adding
                  ? language.t("dialog.server.add.checking")
                  : language.t("dialog.server.add.button")}
              </Button>
            </div>
          </div>
        }
      >
        <ServerCredentials
          url={store.serverCred.url}
          username={store.serverCred.username}
          password={store.serverCred.password}
          error={store.serverCred.error}
          busy={store.serverCred.busy}
          onSubmit={handleCredentialsSubmit}
          onCancel={handleCancelCredentials}
          onUsernameChange={(value: string) => {
            setStore("serverCred", "username", value)
            setStore("serverCred", "error", "")
          }}
          onPasswordChange={(value: string) => {
            setStore("serverCred", "password", value)
            setStore("serverCred", "error", "")
          }}
        />
      </Show>
    </Dialog>
  )
}
