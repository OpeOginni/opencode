import type { FormValue } from "@opencode/client"
import { onCleanup } from "solid-js"
import { useEvent } from "./event"
import { createSimpleContext } from "./helper"

export type FormDraft = {
  tab: number
  answers: Record<string, FormValue | undefined>
  custom: Record<string, string | undefined>
  externalReady: Record<string, boolean>
  selected: number
  editing: boolean
  error: string
  cursor?: number
}

export const { use: useFormDrafts, provider: FormDraftProvider } = createSimpleContext({
  name: "FormDraft",
  init: () => {
    const event = useEvent()
    const drafts = new Map<string, FormDraft>()
    const settling = new Set<string>()

    function settle(formID: string) {
      settling.add(formID)
      drafts.delete(formID)
      // Form data and the active route observe the same event. Delete once more after
      // their synchronous cleanup so that cleanup cannot restore a settled draft.
      queueMicrotask(() => {
        drafts.delete(formID)
        settling.delete(formID)
      })
    }

    onCleanup(event.on("form.replied", (event) => settle(event.data.id)))
    onCleanup(event.on("form.cancelled", (event) => settle(event.data.id)))

    return {
      take(formID: string) {
        const draft = drafts.get(formID)
        drafts.delete(formID)
        return draft
      },
      save(formID: string, draft: FormDraft) {
        if (settling.has(formID)) return
        drafts.set(formID, draft)
      },
      settle,
    }
  },
})
