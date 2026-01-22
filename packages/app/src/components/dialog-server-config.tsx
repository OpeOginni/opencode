import { createMemo } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Tabs } from "@opencode-ai/ui/tabs"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { ServerTab } from "./server-tab"
import { McpTab } from "./mcp-tab"
import { LspTab } from "./lsp-tab"
import { PluginsTab } from "./plugins-tab"

export function DialogServerConfig(
  props: { defaultTab?: "servers" | "mcp" | "lsp" | "plugins" } = { defaultTab: "servers" },
) {
  const server = useServer()
  const sync = useSync()

  const mcpItems = createMemo(() =>
    Object.entries(sync.data.mcp ?? {})
      .map(([name]) => name)
      .sort((a, b) => a.localeCompare(b)),
  )
  const lspItems = createMemo(() => (sync.data.lsp ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)))

  return (
    <Dialog class="min-h-[150px]">
      <Tabs
        aria-label="Server Configurations"
        class="tabs"
        data-component="tabs"
        data-active="servers"
        defaultValue={props.defaultTab}
        variant="alt"
        style={{
          "background-color": "var(--background-base)",
          "border-radius": "12px",
          overflow: "hidden",
        }}
      >
        <Tabs.List
          data-slot="tablist"
          style={{
            "background-color": "var(--background-stronger)",
            "border-bottom": "none",
            padding: "8px 24px 0",
          }}
        >
          <Tabs.Trigger value="servers" data-slot="tab">
            {server.list.length} {server.list.length === 1 ? "Server" : "Servers"}
          </Tabs.Trigger>
          <Tabs.Trigger value="mcp" data-slot="tab">
            {mcpItems().length} {mcpItems().length === 1 ? "MCP" : "MCPs"}
          </Tabs.Trigger>
          <Tabs.Trigger value="lsp" data-slot="tab">
            {lspItems().length} {lspItems().length === 1 ? "LSP" : "LSPs"}
          </Tabs.Trigger>
          <Tabs.Trigger value="plugins" data-slot="tab">
            Plugins
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content data-slot="panel" value="servers">
          <ServerTab />
        </Tabs.Content>

        <Tabs.Content as="div" value="mcp">
          <McpTab />
        </Tabs.Content>

        <Tabs.Content as="div" value="lsp">
          <LspTab />
        </Tabs.Content>

        <Tabs.Content as="div" value="plugins">
          <PluginsTab />
        </Tabs.Content>
      </Tabs>
    </Dialog>
  )
}
