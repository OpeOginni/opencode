import { createMemo } from "solid-js"
import { List } from "@opencode-ai/ui/list"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import type { Component } from "solid-js"

export const PluginsTab: Component = () => {
  const sync = useSync()
  const language = useLanguage()
  const plugins = createMemo(() => sync.data.config.plugin ?? [])

  return (
    <div class="flex flex-col px-2 pb-2">
      <div class="flex flex-col p-2 bg-background-base">
        <List emptyMessage={language.t("dialog.plugins.empty")} items={plugins} key={(x) => x}>
          {(i) => (
            <div class="flex items-center gap-2 min-w-0 flex-1 group/item">
              <span class="truncate">{i}</span>
            </div>
          )}
        </List>
      </div>
    </div>
  )
}
