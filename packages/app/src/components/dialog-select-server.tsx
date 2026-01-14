import { Dialog } from "@opencode-ai/ui/dialog"
import { createSignal, createMemo } from "solid-js"
import { ServerTab } from "./server-tab"

export function DialogSelectServer() {
  const [title, setTitle] = createSignal("Servers")
  const [description, setDescription] = createSignal("Switch which OpenCode server this app connects to.")

  const handleTitleChange = (newTitle: string, newDescription: string) => {
    setTitle(newTitle)
    setDescription(newDescription)
  }

  return (
    <Dialog title={title()} description={description()}>
      <ServerTab onTitleChange={handleTitleChange} />
    </Dialog>
  )
}
