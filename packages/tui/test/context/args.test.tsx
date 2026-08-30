/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { ArgsProvider, useArgs } from "../../src/context/args"

test("consumes the startup prompt once", async () => {
  let args: ReturnType<typeof useArgs>
  function Probe() {
    args = useArgs()
    return <box />
  }
  const app = await testRender(() => (
    <ArgsProvider prompt="FOLLOW_UP">
      <Probe />
    </ArgsProvider>
  ))

  try {
    expect(args!.prompt).toBe("FOLLOW_UP")
    expect(args!.consumePrompt()).toBe("FOLLOW_UP")
    expect(args!.prompt).toBeUndefined()
    expect(args!.consumePrompt()).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})
