import { expect, test } from "bun:test"
import { CopilotAuto } from "@opencode/core/github-copilot/auto"

test("discovers only known, enabled Auto tiers for the account", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      expect(new URL(request.url).pathname).toBe("/meta")
      expect(request.headers.get("authorization")).toBe("Bearer test-token")
      return Response.json({
        auto: {
          tiers: [
            { id: "efficiency", type: "auto", status: { enabled: true } },
            { id: "balance", type: "auto", status: { enabled: false } },
            { id: "intelligence", type: "other", status: { enabled: true } },
            { id: "future", type: "auto", status: { enabled: true } },
          ],
        },
      })
    },
  })
  try {
    expect(await CopilotAuto.loadTiers(server.url.origin, { Authorization: "Bearer test-token" })).toEqual([
      "efficiency",
    ])
  } finally {
    await server.stop(true)
  }
})

test.each([404, 405])("lets older deployments enforce tiers when metadata returns %s", async (status) => {
  const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status }) })
  try {
    expect(await CopilotAuto.loadTiers(server.url.origin, {})).toEqual(["efficiency", "balance", "intelligence"])
  } finally {
    await server.stop(true)
  }
})

test("does not infer tiers from missing metadata or a discovery failure", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/failed/meta" ? new Response(null, { status: 503 }) : Response.json({}),
  })
  try {
    expect(await CopilotAuto.loadTiers(server.url.origin, {})).toEqual([])
    await expect(CopilotAuto.loadTiers(`${server.url.origin}/failed`, {})).rejects.toThrow("503")
  } finally {
    await server.stop(true)
  }
})
