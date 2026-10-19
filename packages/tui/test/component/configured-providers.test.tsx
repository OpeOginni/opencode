import { expect, test } from "bun:test"
import { CliRenderEvents, InputRenderable } from "@opentui/core"
import type { IntegrationInfo } from "@opencode/client"
import { once } from "node:events"
import { DialogIntegration } from "../../src/component/dialog-integration"
import { DialogModel } from "../../src/component/dialog-model"
import { model, renderLocal } from "../fixture/local"
import { directory, json } from "../fixture/tui-client"

test.each([44, 100])("identifies config-only models while browsing and searching at width %s", async (width) => {
  await using setup = await renderLocal({
    models: ["one", "two"].map((providerID) => ({ ...model("chat"), providerID, name: "Same Model" })),
    fetch: (url) => {
      if (url.pathname === "/api/provider")
        return json({
          location: { directory },
          data: [
            { id: "one", name: "Gateway One" },
            { id: "two", name: "Gateway Two" },
          ],
        })
      if (url.pathname === "/api/integration")
        return json({
          location: { directory },
          data: ["one", "two"].map((id) => ({ id, name: id, configured: true, methods: [], connections: [] })),
        })
    },
  })
  setup.resize(width, 30)
  setup.dialog.replace(() => <DialogModel />)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("Gateway One")
  expect(setup.captureCharFrame()).toContain("Gateway Two")

  // DialogSelect defers filter focus until after its first render.
  if (!(setup.renderer.currentFocusedRenderable instanceof InputRenderable))
    await once(setup.renderer, CliRenderEvents.FOCUSED_RENDERABLE)
  await setup.mockInput.typeText("Same Model")
  await setup.renderOnce()
  const rows = setup
    .captureCharFrame()
    .split("\n")
    .filter((line) => line.includes("Same Model") && line.includes("Gateway"))
  expect(rows).toHaveLength(2)
  expect(rows.some((line) => line.includes("Gateway One"))).toBe(true)
  expect(rows.some((line) => line.includes("Gateway Two"))).toBe(true)

  setup.mockInput.pressKey("u", { ctrl: true })
  await setup.mockInput.typeText("Gateway One")
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("Same Model")
  expect(setup.captureCharFrame()).toContain("Gateway One")
  expect(setup.captureCharFrame()).not.toContain("Gateway Two")
})

test("distinguishes configured integrations from connections and sign-in warnings", async () => {
  const integrations: IntegrationInfo[] = [
    { id: "config", name: "Config only", configured: true, methods: [{ type: "key" }], connections: [] },
    {
      id: "account",
      name: "Saved account",
      configured: true,
      methods: [{ type: "key" }],
      connections: [{ type: "credential", id: "cred_work", method: "key", label: "Work" }],
    },
    {
      id: "env",
      name: "Environment",
      configured: true,
      methods: [{ type: "key" }],
      connections: [{ type: "env", name: "GATEWAY_KEY" }],
    },
    {
      id: "expired",
      name: "Expired account",
      configured: true,
      methods: [{ type: "key" }],
      connections: [
        {
          type: "credential",
          id: "cred_expired",
          method: "oauth",
          label: "Expired",
          status: { status: "needs_auth", message: "Sign in again" },
        },
      ],
    },
    { id: "unconfigured", name: "Not configured", methods: [{ type: "key" }], connections: [] },
  ]
  await using setup = await renderLocal({
    fetch: (url) => {
      if (url.pathname === "/api/integration") return json({ location: { directory }, data: integrations })
    },
  })
  setup.dialog.replace(() => <DialogIntegration />)
  await setup.renderOnce()
  const rows = setup.captureCharFrame().split("\n")
  expect(rows.find((line) => line.includes("Config only"))).toContain("Configured")
  expect(rows.find((line) => line.includes("Config only"))).not.toContain("✓")
  expect(rows.find((line) => line.includes("Saved account"))).toContain("Work")
  expect(rows.find((line) => line.includes("Saved account"))).toContain("✓")
  expect(rows.find((line) => line.includes("Environment"))).toContain("$GATEWAY_KEY")
  expect(rows.find((line) => line.includes("Expired account"))).toContain("Sign in required")
  expect(rows.find((line) => line.includes("Expired account"))).not.toContain("✓")
  expect(rows.find((line) => line.includes("Not configured"))).not.toContain("Configured")
})
