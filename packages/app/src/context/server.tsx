import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { batch, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { Persist, persisted } from "@/utils/persist"

type StoredProject = { worktree: string; expanded: boolean }

export function normalizeServerUrl(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
  return withProtocol.replace(/\/+$/, "")
}

export function serverDisplayName(url: string) {
  if (!url) return ""
  return url.replace(/^https?:\/\//, "").replace(/\/+$/, "")
}

function projectsKey(url: string) {
  if (!url) return ""
  const host = url.replace(/^https?:\/\//, "").split(":")[0]
  if (host === "localhost" || host === "127.0.0.1") return "local"
  return url
}

export const { use: useServer, provider: ServerProvider } = createSimpleContext({
  name: "Server",
  init: (props: { defaultUrl: string; sidecarUrl?: string }) => {
    const platform = usePlatform()

    const [store, setStore, _, ready] = persisted(
      Persist.global("server", ["server.v3"]),
      createStore({
        list: [] as string[],
        projects: {} as Record<string, StoredProject[]>,
        lastProject: {} as Record<string, string>,
        isSidecar: {} as Record<string, boolean>,
      }),
    )

    const [active, setActiveRaw] = createSignal("")

    function setActive(input: string) {
      const url = normalizeServerUrl(input)
      if (!url) return
      if (active() === url) return
      setActiveRaw(url)
    }

    function add(input: string) {
      const url = normalizeServerUrl(input)
      if (!url) return
      batch(() => {
        if (!store.list.includes(url)) {
          setStore("list", store.list.length, url)
        }
        setActiveRaw(url)
      })
    }

    function remove(input: string) {
      const url = normalizeServerUrl(input)
      if (!url) return

      const list = store.list.filter((x) => x !== url)
      const next = active() === url ? (list[0] ?? normalizeServerUrl(props.defaultUrl) ?? "") : active()

      batch(() => {
        setStore("list", list)
        if (store.isSidecar[url]) setStore("isSidecar", url, false)
        setActiveRaw(next)
      })
    }

    const [healthy, setHealthy] = createSignal<boolean | undefined>(undefined)

    const check = async (url: string) => {
      const sdk = createOpencodeClient({
        baseUrl: url,
        fetch: platform.fetch,
        signal: AbortSignal.timeout(3000),
      })
      return sdk.global
        .health()
        .then((x) => x.data?.healthy === true)
        .catch(() => false)
    }

    createEffect(() => {
      if (!ready()) return
      if (active()) return
      const url = normalizeServerUrl(props.defaultUrl)
      if (!url) return

      const sidecar = normalizeServerUrl(props.sidecarUrl ?? "")
      const shouldCheck = platform.platform === "desktop" && !!sidecar && sidecar !== url

      const setUrl = (next: string) => {
        batch(() => {
          if (!store.list.includes(next)) {
            setStore("list", store.list.length, next)
          }
          setActiveRaw(next)
        })
      }

      if (!shouldCheck) {
        setUrl(url)
        return
      }

      let alive = true

      void check(url).then((ok) => {
        if (!alive) return
        if (ok) {
          setUrl(url)
          return
        }
        setUrl(sidecar)
      })

      onCleanup(() => {
        alive = false
      })
    })

    createEffect(() => {
      if (!ready()) return
      if (platform.platform !== "desktop") return
      const url = normalizeServerUrl(props.sidecarUrl ?? "")
      if (!url) return
      const stale = Object.keys(store.isSidecar).filter((key) => store.isSidecar[key] && key !== url)
      if (stale.length === 0 && store.isSidecar[url]) return
      batch(() => {
        for (const key of stale) {
          setStore("list", (prev) => prev.filter((item) => item !== key))
          setStore("isSidecar", key, false)
        }
        if (!store.list.includes(url)) {
          setStore("list", store.list.length, url)
        }
        setStore("isSidecar", url, true)
      })
    })

    const isReady = createMemo(() => ready() && !!active())

    createEffect(() => {
      const url = active()
      if (!url) return

      setHealthy(undefined)

      let alive = true
      let busy = false

      const run = () => {
        if (busy) return
        busy = true
        void check(url)
          .then((next) => {
            if (!alive) return
            setHealthy(next)
          })
          .finally(() => {
            busy = false
          })
      }

      run()
      const interval = setInterval(run, 10_000)

      onCleanup(() => {
        alive = false
        clearInterval(interval)
      })
    })

    const origin = createMemo(() => projectsKey(active()))
    const projectsList = createMemo(() => store.projects[origin()] ?? [])
    const isLocal = createMemo(() => origin() === "local")

    return {
      ready: isReady,
      healthy,
      isLocal,
      get url() {
        return active()
      },
      get name() {
        return serverDisplayName(active())
      },
      get list() {
        return store.list
      },
      setActive,
      add,
      remove,
      projects: {
        list: projectsList,
        open(directory: string) {
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          if (current.find((x) => x.worktree === directory)) return
          setStore("projects", key, [{ worktree: directory, expanded: true }, ...current])
        },
        close(directory: string) {
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          setStore(
            "projects",
            key,
            current.filter((x) => x.worktree !== directory),
          )
        },
        expand(directory: string) {
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          const index = current.findIndex((x) => x.worktree === directory)
          if (index !== -1) setStore("projects", key, index, "expanded", true)
        },
        collapse(directory: string) {
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          const index = current.findIndex((x) => x.worktree === directory)
          if (index !== -1) setStore("projects", key, index, "expanded", false)
        },
        move(directory: string, toIndex: number) {
          const key = origin()
          if (!key) return
          const current = store.projects[key] ?? []
          const fromIndex = current.findIndex((x) => x.worktree === directory)
          if (fromIndex === -1 || fromIndex === toIndex) return
          const result = [...current]
          const [item] = result.splice(fromIndex, 1)
          result.splice(toIndex, 0, item)
          setStore("projects", key, result)
        },
        last() {
          const key = origin()
          if (!key) return
          return store.lastProject[key]
        },
        touch(directory: string) {
          const key = origin()
          if (!key) return
          setStore("lastProject", key, directory)
        },
      },
    }
  },
})
