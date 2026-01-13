import { createSimpleContext } from "./helper"

export interface Args {
  username?: string
  password?: string
  model?: string
  agent?: string
  prompt?: string
  continue?: boolean
  sessionID?: string
}

export const { use: useArgs, provider: ArgsProvider } = createSimpleContext({
  name: "Args",
  init: (props: Args) => props,
})
