import { createSignal, createMemo } from "solid-js"
import { List } from "@opencode-ai/ui/list"
import { Switch } from "@opencode-ai/ui/switch"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import type { Component } from "solid-js"

export const McpTab: Component = () => {
  const sync = useSync()
  const sdk = useSDK()
  const [mcpLoading, setMcpLoading] = createSignal<string | null>(null)

  const mcpItems = createMemo(() =>
    Object.entries(sync.data.mcp ?? {})
      .map(([name, status]) => ({ name, status: status.status }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  )

  const toggleMcp = async (name: string) => {
    if (mcpLoading()) return
    setMcpLoading(name)
    const status = sync.data.mcp[name]
    if (status?.status === "connected") {
      await sdk.client.mcp.disconnect({ name })
    } else {
      await sdk.client.mcp.connect({ name })
    }
    const result = await sdk.client.mcp.status()
    if (result.data) sync.set("mcp", result.data)
    setMcpLoading(null)
  }

  return (
    <div class="flex flex-col gap-4 pb-6 pt-4 min-h-[150px]">
      <List
        search={{ placeholder: "Search MCPs", autofocus: true }}
        emptyMessage="No MCPs configured"
        items={mcpItems}
        key={(x) => x.name}
        onSelect={(x) => {
          if (x) toggleMcp(x.name)
        }}
      >
        {(i) => {
          const mcpStatus = () => sync.data.mcp[i.name]
          const status = () => mcpStatus()?.status
          const enabled = () => status() === "connected"
          return (
            <div class="flex items-center gap-2 min-w-0 flex-1 group/item">
              <div class="flex items-center gap-2 min-w-0 flex-1">
                <div
                  classList={{
                    "size-1.5 rounded-full shrink-0": true,
                    "bg-icon-success-base": status() === "connected",
                    "bg-icon-critical-base": status() === "failed",
                    "bg-border-weak-base": status() !== "connected" && status() !== "failed",
                  }}
                />
                <span class="truncate">{i.name}</span>
              </div>
              <div onClick={(e) => e.stopPropagation()}>
                <Switch checked={enabled()} disabled={mcpLoading() === i.name} onChange={() => toggleMcp(i.name)} />
              </div>
            </div>
          )
        }}
      </List>
    </div>
  )
}
