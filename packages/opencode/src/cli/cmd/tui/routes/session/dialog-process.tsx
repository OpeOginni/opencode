import { ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useToast } from "@tui/ui/toast"
import { batch, createEffect, createMemo, on, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import path from "path"
import type { ProcessInfo } from "@opencode-ai/sdk/v2"

export function openProcessLogs(dialog: ReturnType<typeof useDialog>, proc: ProcessInfo) {
  dialog.replace(() => <DialogProcessLogs proc={proc} />)
}

export function DialogProcessList(props: { list: ProcessInfo[] }) {
  const dialog = useDialog()
  return (
    <DialogSelect
      title="Active processes"
      placeholder="Search processes"
      options={props.list.map((item) => ({
        title: item.title,
        value: item,
        description: `${path.basename(item.cwd)} · pid ${item.pid}`,
        footer: item.command,
        category: "Process",
      }))}
      onSelect={(option) => openProcessLogs(dialog, option.value)}
    />
  )
}

export function DialogProcessLogs(props: { proc: ProcessInfo }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const { theme } = useTheme()
  const [store, setStore] = createStore({
    text: "",
    cursor: 0,
    running: true,
    ready: false,
    exited: false,
    exitCode: undefined as number | null | undefined,
  })
  const alive = {
    value: true,
    run: 0,
  }

  const live = createMemo(() => sync.data.process.find((item) => item.id === props.proc.id))
  const item = createMemo(() => live() ?? props.proc)
  const title = createMemo(() => item().title || item().command)
  const place = createMemo(() => {
    const dir = sync.data.path.directory
    if (!dir) return item().cwd
    const rel = path.relative(dir, item().cwd)
    return rel && !rel.startsWith("..") ? rel : item().cwd
  })
  const status = createMemo(() => (store.running ? `Running · pid ${item().pid}` : "Exited"))

  createEffect(() => {
    if (live()) return
    if (!store.ready || store.exited) return
    const line = store.exitCode !== undefined && store.exitCode !== null ? ` with code ${store.exitCode}` : ""
    batch(() => {
      setStore("running", false)
      setStore("exited", true)
    })
    toast.show({
      variant: "info",
      message: `Process exited${line}`,
      duration: 3000,
    })
  })

  let scroll: ScrollBoxRenderable | undefined

  const scrollend = () => {
    setTimeout(() => {
      if (!scroll || scroll.isDestroyed) return
      scroll.scrollTo(scroll.scrollHeight)
    }, 1)
  }

  const stop = async () => {
    await sdk.client.process.stop({ processID: item().id, body: {} }).catch((err) => {
      toast.show({
        variant: "error",
        message: err instanceof Error ? err.message : "Failed to stop process",
        duration: 3000,
      })
    })
  }

  createEffect(
    on(
      () => item().id,
      (id) => {
        const run = ++alive.run
        const ctrl = new AbortController()
        batch(() => {
          setStore("text", "")
          setStore("cursor", 0)
          setStore("running", true)
          setStore("ready", false)
          setStore("exited", false)
          setStore("exitCode", undefined)
        })
        const load = async () => {
          sdk.connectProcess(
            {
              processID: id,
              cursor: 0,
            },
            {
              signal: ctrl.signal,
              onEvent: (event) => {
                if (!alive.value || alive.run !== run) return
                if (event.type === "connected") return

                if (event.type === "output") {
                  batch(() => {
                    setStore("text", (text) => text + event.text)
                    setStore("cursor", event.cursor)
                    setStore("ready", true)
                  })
                  scrollend()
                  return
                }

                batch(() => {
                  setStore("running", false)
                  setStore("ready", true)
                  setStore("exited", true)
                  setStore("exitCode", event.exitCode)
                })
              },
              onError: (err) => {
                if (ctrl.signal.aborted) return
                toast.show({
                  variant: "error",
                  message: err instanceof Error ? err.message : "Failed to load process logs",
                  duration: 3000,
                })
              },
            },
          )
        }

        void load()

        onCleanup(() => ctrl.abort())
      },
    ),
  )

  onMount(() => {
    dialog.setSize("xlarge")
  })

  onCleanup(() => {
    alive.value = false
    alive.run++
  })

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {title()}
        </text>
        <box flexDirection="row" gap={1}>
          <box
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={theme.backgroundElement}
            onMouseUp={() => dialog.clear()}
          >
            <text fg={theme.text}>close</text>
          </box>
          <text fg={theme.textMuted}>esc</text>
        </box>
      </box>
      <text fg={theme.textMuted}>{item().command}</text>
      <text fg={theme.textMuted}>
        {place()} · {status()}
      </text>
      <box flexDirection="row" gap={1}>
        <box paddingLeft={1} paddingRight={1} backgroundColor={theme.backgroundElement}>
          <text fg={theme.textMuted}>combined</text>
        </box>
        <Show when={store.running}>
          <box paddingLeft={1} paddingRight={1} backgroundColor={theme.backgroundElement} onMouseUp={() => void stop()}>
            <text fg={theme.error}>end process</text>
          </box>
        </Show>
      </box>
      <box backgroundColor={theme.background} paddingLeft={1} paddingRight={1}>
        <scrollbox
          ref={scroll}
          height={26}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <text fg={theme.text}>{store.text || "Waiting for output..."}</text>
        </scrollbox>
      </box>
      <text fg={theme.textMuted}>
        Only active processes can be viewed. Once a process exits it disappears from the active list.
      </text>
    </box>
  )
}
