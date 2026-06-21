import type { Workspace } from "@opencode-ai/sdk/v2"
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

type WorkspaceOption = { type: "local" } | { type: "workspace"; workspace: Workspace }

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

  const current = createMemo(() => project.workspace.current())

  const options = createMemo<DialogSelectOption<WorkspaceOption>[]>(() =>
    [
      {
        title: "Local project",
        value: { type: "local" as const },
        footer: "local",
        category: "Current project",
        gutter: () => <text fg={current() ? theme.textMuted : theme.success}>●</text>,
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
          value: { type: "workspace" as const, workspace },
          category: "Workspaces",
          footer: workspace.type,
          details: expanded[workspace.id] && workspace.directory ? [workspace.directory] : undefined,
          gutter: () => <text fg={current() === workspace.id ? theme.success : status === "connected" ? theme.textMuted : theme.error}>●</text>,
        }
      }),
    ],
  )

  function showDetails(option: WorkspaceOption) {
    if (option.type === "local") return
    setExpanded(option.workspace.id, (open) => !open)
  }

  async function switchTo(option: WorkspaceOption) {
    const workspaceID = option.type === "workspace" ? option.workspace.id : undefined
    if (current() === workspaceID) {
      dialog.clear()
      return
    }

    project.workspace.set(workspaceID)
    dialog.clear()
    if (route.data.type === "session") route.navigate({ type: "home" })
    await sync.bootstrap({ fatal: false }).catch((err) => {
      toast.show({ title: "Failed to switch workspace", message: errorMessage(err), variant: "error" })
    })
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
  })

  return (
    <DialogSelect
      title="Workspaces"
      options={options()}
      onMove={(option) => {
        setDeleting(undefined)
      }}
      onSelect={(option) => void switchTo(option.value)}
      actions={[
        {
          command: "dialog.workspace.details",
          title: "details",
          disabled: (option) => option?.value.type !== "workspace",
          onTrigger: (option) => showDetails(option.value),
        },
        {
          command: "session.delete",
          title: "delete",
          disabled: (option) => option?.value.type !== "workspace",
          onTrigger: (option) => {
            if (option.value.type === "workspace") void remove(option.value.workspace)
          },
        },
      ]}
    />
  )
}
