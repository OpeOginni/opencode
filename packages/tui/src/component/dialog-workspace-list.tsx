import type { ExperimentalWorkspaceAdapterListResponse, Workspace } from "@opencode-ai/sdk/v2"
import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useProject } from "../context/project"
import { useRoute } from "../context/route"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { createMemo, createSignal, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { errorMessage } from "../util/error"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { workspaceProvenance } from "./dialog-workspace-create"

type WorkspaceOption = { workspace?: Workspace }

export function DialogWorkspaceList() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const project = useProject()
  const { theme } = useTheme()
  const [deleting, setDeleting] = createSignal<string>()
  const [removing, setRemoving] = createSignal<string>()
  const [expanded, setExpanded] = createStore<Record<string, boolean>>({})
  const [adapters, setAdapters] = createSignal<ExperimentalWorkspaceAdapterListResponse>()

  const current = createMemo(() => {
    if (route.data.type === "session") return sync.session.get(route.data.sessionID)?.workspaceID
    return project.workspace.current()
  })

  // The "Main" row is the LOCAL project; instance/path context can point at a
  // remote workspace's directory after a move, so prefer the SDK's directory.
  const mainDirectory = createMemo(() => sdk.directory || project.instance.directory() || sync.path.directory)

  const options = createMemo<DialogSelectOption<WorkspaceOption>[]>(() => [
    {
      title: "Main",
      value: {},
      footer: "local · main",
      details: expanded["main"] && mainDirectory() ? [mainDirectory()!] : undefined,
      gutter: () => <text fg={theme.success}>●</text>,
    },
    ...project.workspace
      .list()
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((workspace) => {
        const status = project.workspace.status(workspace.id)
        return {
          title:
            removing() === workspace.id
              ? "Deleting..."
              : deleting() === workspace.id
                ? `Delete ${workspace.name}? Press delete again`
                : workspace.name,
          value: { workspace },
          footer: workspaceProvenance(adapters(), workspace),
          details: expanded[workspace.id] && workspace.directory ? [workspace.directory] : undefined,
          gutter: () => <text fg={status === "connected" ? theme.success : theme.error}>●</text>,
        }
      }),
  ])

  function showDetails(workspace?: Workspace) {
    setExpanded(workspace?.id ?? "main", (open) => !open)
  }

  async function remove(workspace: Workspace) {
    if (removing()) return
    if (deleting() !== workspace.id) {
      setDeleting(workspace.id)
      return
    }

    setDeleting(undefined)
    setRemoving(workspace.id)
    const result = await sdk.client.experimental.workspace.remove({ id: workspace.id }).catch((err) => ({
      error: err,
    }))
    if (result?.error) {
      setRemoving(undefined)
      toast.show({
        variant: "error",
        title: "Failed to delete workspace",
        message: errorMessage(result.error),
      })
      return
    }

    if (current() === workspace.id) {
      project.workspace.set(undefined)
      route.navigate({ type: "home" })
    }
    await project.workspace.sync()
    await sync.bootstrap({ fatal: false }).catch(() => undefined)
    setRemoving(undefined)
  }

  onMount(() => {
    dialog.setSize("large")
    void sdk.client.experimental.workspace.syncList().catch(() => undefined)
    void project.workspace.sync()
    void sdk.client.experimental.workspace.adapter
      .list({ directory: mainDirectory() })
      .then((response) => {
        if (response.data) setAdapters(response.data)
      })
      .catch(() => undefined)
  })

  return (
    <DialogSelect
      title="Workspaces"
      options={options()}
      onMove={(option) => {
        setDeleting(undefined)
      }}
      onSelect={(option) => showDetails(option.value.workspace)}
      actions={[
        {
          command: "session.delete",
          title: "delete",
          onTrigger: (option) => {
            if (!option.value.workspace) return
            void remove(option.value.workspace)
          },
        },
      ]}
    />
  )
}
