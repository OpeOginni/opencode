import { expect, test } from "bun:test"
import { CopilotAuto } from "@opencode/core/github-copilot/auto"

test("discovers enabled Auto tiers without guessing on missing or failed metadata", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname
      if (path === "/missing/meta") return new Response(null, { status: 404 })
      if (path === "/unsupported/meta") return new Response(null, { status: 405 })
      if (path === "/failed/meta") return new Response(null, { status: 503 })
      if (path === "/empty/meta") return Response.json({})
      expect(path).toBe("/meta")
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
    for (const path of ["missing", "unsupported"])
      expect(await CopilotAuto.loadTiers(`${server.url.origin}/${path}`, {})).toEqual(CopilotAuto.tiers)
    expect(await CopilotAuto.loadTiers(`${server.url.origin}/empty`, {})).toEqual([])
    await expect(CopilotAuto.loadTiers(`${server.url.origin}/failed`, {})).rejects.toThrow("503")
  } finally {
    await server.stop(true)
  }
})

test.each([404, 405])("uses legacy routing only for untiered Auto when /auto returns %s", async (status) => {
  const requests: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      requests.push(path)
      if (path === "/auto") return new Response(null, { status })
      if (path === "/models/session")
        return Response.json({
          session_token: "legacy-token",
          expires_at: Date.now() / 1000 + 86400,
          selected_model: "fallback",
          available_models: ["routed"],
        })
      expect(path).toBe("/models/session/intent")
      expect(request.headers.get("copilot-session-token")).toBe("legacy-token")
      expect(await request.json()).toEqual({
        prompt: "Review this",
        has_image: false,
        available_models: ["routed"],
        routing_intent: "anchor",
        turns_since_anchor: 0,
      })
      return Response.json({ chosen_model: "routed" })
    },
  })
  try {
    const router = new CopilotAuto.Router(server.url.origin, {})
    expect(await router.route({ prompt: "Review this", image: false })).toMatchObject({
      model: "routed",
      token: "legacy-token",
    })
    await expect(router.route({ prompt: "Review this", image: false, tier: "intelligence" })).rejects.toThrow(
      "unsupported",
    )
    expect(requests).toEqual(["/auto", "/models/session", "/models/session/intent", "/auto"])
  } finally {
    await server.stop(true)
  }
})
