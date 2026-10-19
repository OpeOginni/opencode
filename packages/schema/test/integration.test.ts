import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Integration } from "../src/integration.js"

test("integration configuration is optional and does not create a connection", () => {
  const encode = Schema.encodeSync(Integration.Info)
  const integration = Integration.Info.make({
    id: Integration.ID.make("custom"),
    name: "Custom",
    methods: [],
    connections: [],
  })

  expect(encode({ ...integration, configured: undefined })).not.toHaveProperty("configured")
  expect(encode({ ...integration, configured: true })).toMatchObject({ configured: true, connections: [] })
  expect(encode({ ...integration, configured: false })).toMatchObject({ configured: false, connections: [] })
})
