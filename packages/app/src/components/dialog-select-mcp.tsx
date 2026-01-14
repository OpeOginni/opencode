import { Component, createMemo } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { McpTab } from "./mcp-tab"
import { useSync } from "@/context/sync"

export const DialogSelectMcp: Component = () => {
  const sync = useSync()

  const mcpItems = createMemo(() =>
    Object.entries(sync.data.mcp ?? {})
      .map(([name, status]) => ({ name, status: status.status }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  )

  const enabledCount = createMemo(() => mcpItems().filter((i) => i.status === "connected").length)
  const totalCount = createMemo(() => mcpItems().length)

  return (
    <Dialog title="MCPs" description={`${enabledCount()} of ${totalCount()} enabled`}>
      <McpTab />
    </Dialog>
  )
}
