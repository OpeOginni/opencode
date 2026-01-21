import type { Component } from "solid-js"

export const LspTab: Component = () => {
  return (
    <div class="flex flex-col px-2 pb-2">
      <div class="flex items-center justify-center p-6 h-[144px] bg-background-base">
        <span class="text-text-weak">LSPs auto-detected from file types</span>
      </div>
    </div>
  )
}
