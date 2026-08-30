import { createSimpleContext } from "./helper"
import { createSignal } from "solid-js"

export interface Args {
  model?: string
  agent?: string
  prompt?: string
  continue?: boolean
  sessionID?: string
  fork?: boolean
  auto?: boolean
}

export const { use: useArgs, provider: ArgsProvider } = createSimpleContext({
  name: "Args",
  init: (props: Args) => {
    const [prompt, setPrompt] = createSignal(props.prompt)
    return {
      model: props.model,
      agent: props.agent,
      continue: props.continue,
      sessionID: props.sessionID,
      fork: props.fork,
      auto: props.auto,
      get prompt() {
        return prompt()
      },
      consumePrompt() {
        const value = prompt()
        setPrompt(undefined)
        return value
      },
    }
  },
})
