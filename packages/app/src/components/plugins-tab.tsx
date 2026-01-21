import type { Component } from "solid-js"

export const PluginsTab: Component = () => {
  return (
    <div class="flex flex-col px-2 pb-2">
      <div class="flex items-center justify-center p-6 h-[144px] bg-background-base">
        <span class="text-text-weak">
          Plugins configured in <code class="bg-surface-raised-base-hover px-1 py-0.5 rounded-sm">opencode.json</code>
        </span>
      </div>
    </div>
  )
}
