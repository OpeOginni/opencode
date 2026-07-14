import type { ExperimentalWorkspaceAdapterListResponse, Workspace } from "@opencode-ai/sdk/v2"
import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useSync } from "../context/sync"
import { useProject } from "../context/project"
import { useRoute } from "../context/route"
import { createMemo, createSignal, onMount } from "solid-js"
import { errorMessage } from "../util/error"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { DialogWorkspaceFileChanges } from "./dialog-workspace-file-changes"

type Adapter = ExperimentalWorkspaceAdapterListResponse[number]

export type WorkspaceSelection =
  | {
      type: "none"
    }
  | {
      type: "new"
      workspaceType: string
      workspaceName: string
    }
  | {
      type: "existing"
      workspaceID: string
      workspaceType: string
      workspaceName: string
    }

type WorkspaceSelectValue =
  | WorkspaceSelection
  | { type: "existing-list" }
  | { type: "remote-list" }
  | { type: "remote-empty" }
type ExistingWorkspaceSelectValue = { workspace: Workspace }

export function recentConnectedWorkspaces<WorkspaceInfo extends { id: string; timeUsed: number | string }>(input: {
  workspaces: readonly WorkspaceInfo[]
  status: (workspaceID: string) => string | undefined
  limit?: number
  omitWorkspaceID?: string
}) {
  const allWorkspaces = input.workspaces.filter((workspace) =>
    ["connected", "paused"].includes(input.status(workspace.id) ?? ""),
  )
  const workspaces = allWorkspaces.toSorted((a, b) => Number(b.timeUsed) - Number(a.timeUsed))
  const recent = workspaces.slice(0, input.limit ?? 3)

  return { recent, hasMore: recent.length < workspaces.length }
}

// Human-readable provenance for a workspace row: the registering adapter's
// name plus whether it runs locally or remotely (e.g. "Gitterm · remote",
// "Worktree · local"). Falls back to the raw workspace type when the adapter
// is not currently registered.
export function workspaceProvenance(
  adapters: readonly { type: string; kind?: string | null; name: string }[] | undefined,
  workspace: { type: string },
) {
  const adapter = adapters?.find((item) => item.type === workspace.type)
  const kind = adapter?.kind ?? (workspace.type === "worktree" ? "local" : "remote")
  const name = adapter?.name ?? workspace.type
  return `${name} · ${kind}`
}

// Remote workspace adapters are those a plugin registered. The built-in
// "remote" (connect to an existing opencode server) and "worktree" adapters
// are never offered as remote workspaces.
export function remoteWorkspaceAdapters<T extends { type: string; kind?: string | null; name: string }>(
  adapters: readonly T[],
): T[] {
  return adapters
    .filter((adapter) => adapter.kind === "remote" && adapter.type !== "remote" && adapter.type !== "worktree")
    .toSorted((a, b) => a.name.localeCompare(b.name))
}

export function warpReminderText(dir: string) {
  return `<system-reminder>The user has changed the current working directory to "${dir}". This is still the same project but at a possibly new location; take this into account when working with any files from now on.</system-reminder>`
}

async function loadWorkspaceAdapters(input: {
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  toast: ReturnType<typeof useToast>
}) {
  // sync.path can hold a REMOTE workspace's directory after a move; adapter
  // listing is a control-plane call and must use a directory that exists on
  // this machine.
  const dir = input.sdk.directory || input.sync.path.directory
  try {
    const response = await input.sdk.client.experimental.workspace.adapter.list({ directory: dir })
    if (response.error) throw response.error
    return response.data
  } catch (err) {
    input.toast.show({
      title: "Failed to load workspace adapters",
      message: errorMessage(err),
      variant: "error",
    })
    return undefined
  }
}

export async function openWorkspaceSelect(input: {
  dialog: ReturnType<typeof useDialog>
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  project: ReturnType<typeof useProject>
  toast: ReturnType<typeof useToast>
  onSelect: (selection: WorkspaceSelection) => Promise<void> | void
}) {
  input.dialog.clear()
  await input.sdk.client.experimental.workspace.syncList().catch(() => undefined)
  await input.project.workspace.sync().catch(() => undefined)
  const adapters = await loadWorkspaceAdapters(input)
  if (!adapters) return
  input.dialog.replace(() => <DialogWorkspaceSelect adapters={adapters} onSelect={input.onSelect} />)
}

export async function moveWorkspaceSession(input: {
  dialog: ReturnType<typeof useDialog>
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  project: ReturnType<typeof useProject>
  toast: ReturnType<typeof useToast>
  sourceWorkspaceID?: string
  workspaceID: string | null
  sessionID: string
  copyChanges: boolean
  done?: () => void
}): Promise<boolean> {
  let result
  try {
    const directory = input.workspaceID
      ? input.project.workspace.get(input.workspaceID)?.directory
      : input.project.instance.directory() || input.sync.path.directory
    if (!directory) throw new Error("Workspace did not return a project directory")
    result = await input.sdk.client.experimental.controlPlane.moveSession({
      sessionID: input.sessionID,
      destination: { directory, ...(input.workspaceID ? { workspaceID: input.workspaceID } : {}) },
      moveChanges: input.copyChanges,
    })
  } catch (err) {
    input.toast.show({
      title: "Failed to move session",
      message: errorMessage(err),
      variant: "error",
    })
    return false
  }
  if (!result?.data) {
    input.toast.show({
      title: "Failed to move session",
      message: errorMessage(result?.error ?? "no response"),
      variant: "error",
    })
    return false
  }

  input.project.workspace.set(input.workspaceID)

  await input.sync.bootstrap({ fatal: false }).catch(() => undefined)

  const dir = input.project.instance.directory() || input.sync.path.directory
  if (dir) {
    await input.sdk.client.session
      .promptAsync({
        sessionID: input.sessionID,
        workspace: input.workspaceID ?? undefined,
        noReply: true,
        parts: [
          {
            type: "text",
            text: warpReminderText(dir),
            synthetic: true,
          },
        ],
      })
      .catch(() => undefined)
  }

  await Promise.all([input.project.workspace.sync(), input.sync.session.refresh()])

  if (input.done) {
    input.done()
    return true
  }
  input.dialog.clear()
  return true
}

export async function confirmWorkspaceFileChanges(input: {
  dialog: ReturnType<typeof useDialog>
  sdk: ReturnType<typeof useSDK>
  sourceWorkspaceID?: string
}) {
  const status = await input.sdk.client.vcs.status({ workspace: input.sourceWorkspaceID }).catch(() => undefined)
  // A source whose changes cannot be inspected must not silently drop them:
  // default to copying — an empty patch is a no-op, and an unreachable source
  // fails the move with a visible error instead.
  if (!status?.data) return true
  const fileChangeChoice = status.data.length ? await DialogWorkspaceFileChanges.show(input.dialog, status.data) : "no"
  if (!fileChangeChoice) return
  return fileChangeChoice === "yes"
}

export function DialogWorkspaceSelect(props: {
  adapters?: Adapter[]
  onSelect: (selection: WorkspaceSelection) => Promise<void> | void
}) {
  const dialog = useDialog()
  const project = useProject()
  const route = useRoute()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const [adapters, setAdapters] = createSignal<Adapter[] | undefined>(props.adapters)
  const [createStep, setCreateStep] = createSignal<"root" | "remote">("root")
  const omittedWorkspaceID = createMemo(() => (route.data.type === "session" ? project.workspace.current() : undefined))

  onMount(() => {
    dialog.setSize("medium")
    void (async () => {
      if (adapters()) return
      const res = await loadWorkspaceAdapters({ sdk, sync, toast })
      if (!res) return
      setAdapters(res)
    })()
  })

  const options = createMemo<DialogSelectOption<WorkspaceSelectValue>[]>(() => {
    const list = adapters()
    if (!list) return []
    const remote = remoteWorkspaceAdapters(list)
    if (createStep() === "remote") {
      if (remote.length === 0) {
        return [
          {
            title: "No remote adapters",
            value: { type: "remote-empty" as const },
            description: "You have no registered remote workspace adapters",
            category: "Remote adapters",
            disabled: true,
          },
        ]
      }
      return remote.map((adapter) => ({
        title: adapter.name,
        value: { type: "new" as const, workspaceType: adapter.type, workspaceName: adapter.name },
        description: adapter.description,
        category: "Remote adapters",
      }))
    }
    const local = list
      .filter((adapter) => adapter.kind === "local" || adapter.type === "worktree")
      .toSorted((a, b) => {
        if (a.type === "worktree") return -1
        if (b.type === "worktree") return 1
        return a.name.localeCompare(b.name)
      })
    const { recent, hasMore } = recentConnectedWorkspaces({
      workspaces: project.workspace.list(),
      status: project.workspace.status,
      omitWorkspaceID: omittedWorkspaceID(),
    })
    return [
      ...local.map((adapter) => ({
        title: adapter.name,
        value: { type: "new" as const, workspaceType: adapter.type, workspaceName: adapter.name },
        description: adapter.description,
        category: "New workspace",
      })),
      {
        title: "Remote",
        value: { type: "remote-list" as const },
        description: "Choose a remote workspace adapter",
        category: "New workspace",
      },
      {
        title: "Local (main)",
        value: { type: "none" as const },
        description: "Your main local project",
        category: "Choose workspace",
      },
      ...recent.map((workspace: Workspace) => ({
        title: workspace.name,
        description: `${workspaceProvenance(list, workspace)} · ${project.workspace.status(workspace.id)}`,
        value: {
          type: "existing" as const,
          workspaceID: workspace.id,
          workspaceType: workspace.type,
          workspaceName: workspace.name,
        },
        category: "Choose workspace",
      })),
      ...(hasMore
        ? [
            {
              title: "View all workspaces",
              value: { type: "existing-list" as const },
              description: "Choose from all workspaces",
              category: "Choose workspace",
            },
          ]
        : []),
    ]
  })

  if (!adapters()) return null
  return (
    <DialogSelect<WorkspaceSelectValue>
      title={createStep() === "remote" ? "Choose remote adapter" : "Move session"}
      skipFilter={true}
      renderFilter={false}
      options={options()}
      onSelect={(option) => {
        if (!option.value) return
        if (option.value.type === "remote-empty") return
        if (option.value.type === "remote-list") {
          setCreateStep("remote")
          return
        }
        if (option.value.type === "none") {
          void props.onSelect(option.value)
          return
        }
        if (option.value.type === "new") {
          void props.onSelect(option.value)
          return
        }
        if (option.value.type === "existing") {
          void props.onSelect(option.value)
          return
        }

        dialog.replace(() => (
          <DialogExistingWorkspaceSelect
            adapters={adapters()}
            omitWorkspaceID={omittedWorkspaceID()}
            onSelect={props.onSelect}
          />
        ))
      }}
    />
  )
}

function DialogExistingWorkspaceSelect(props: {
  adapters?: Adapter[]
  omitWorkspaceID?: string
  onSelect: (selection: WorkspaceSelection) => Promise<void> | void
}) {
  const project = useProject()

  const options = createMemo<DialogSelectOption<ExistingWorkspaceSelectValue>[]>(() =>
    project.workspace
      .list()
      .filter((workspace) => ["connected", "paused"].includes(project.workspace.status(workspace.id) ?? ""))
      .filter((workspace) => workspace.id !== props.omitWorkspaceID)
      .map((workspace: Workspace) => ({
        title: workspace.name,
        description: workspaceProvenance(props.adapters, workspace),
        value: { workspace },
      })),
  )

  return (
    <DialogSelect<ExistingWorkspaceSelectValue>
      title="Existing Workspace"
      options={options()}
      onSelect={(option) => {
        void props.onSelect({
          type: "existing",
          workspaceID: option.value.workspace.id,
          workspaceType: option.value.workspace.type,
          workspaceName: option.value.workspace.name,
        })
      }}
    />
  )
}
