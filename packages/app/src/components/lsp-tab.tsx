import { createMemo } from "solid-js"
import { List } from "@opencode-ai/ui/list"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import type { Component } from "solid-js"

export const LspTab: Component = () => {
  const sync = useSync()
  const language = useLanguage()
  const lspItems = createMemo(() => (sync.data.lsp ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)))

  return (
    <div class="flex flex-col px-2 pb-2">
      <div class="flex flex-col p-2 bg-background-base">
        <List
          class="[&_[data-slot=list-scroll]_[data-slot=list-group]:last-child]:pb-0"
          emptyMessage={language.t("dialog.lsp.empty")}
          items={lspItems}
          key={(x) => x.id}
        >
          {(i) => (
            <div class="flex items-center gap-2 min-w-0 flex-1 group/item">
              <div class="flex items-center gap-2 min-w-0 flex-1">
                <div
                  classList={{
                    "size-1.5 rounded-full shrink-0": true,
                    "bg-icon-success-base": i.status === "connected",
                    "bg-border-weak-base": i.status !== "connected",
                  }}
                />
                <span class="truncate">{i.name}</span>
              </div>
            </div>
          )}
        </List>
      </div>
    </div>
  )
}
