export * as CopilotAuto from "./auto.js"

import { Schema } from "effect"

export const tiers = ["efficiency", "balance", "intelligence"] as const
export type Tier = (typeof tiers)[number]

const Metadata = Schema.Struct({
  auto: Schema.optional(
    Schema.Struct({
      tiers: Schema.Array(
        Schema.Struct({ id: Schema.String, type: Schema.String, status: Schema.Struct({ enabled: Schema.Boolean }) }),
      ),
    }),
  ),
})
const decodeMetadata = Schema.decodeUnknownSync(Metadata)

const Response = Schema.Struct({
  session_token: Schema.String,
  expires_at: Schema.Number,
  selected_model: Schema.Struct({ id: Schema.String }),
})
const decodeResponse = Schema.decodeUnknownSync(Response)

/** A prompt's routed model. `token` unlocks auto-only models and the auto discount on paid plans. */
export interface Route {
  readonly model: string
  readonly token?: string
  /** Epoch milliseconds after which the model/token pair must be refreshed. */
  readonly until: number
}

// Copilot session tokens last 24 hours; route again before one can expire mid-request.
const refreshMargin = 5 * 60 * 1000

export async function loadTiers(baseURL: string, headers: Record<string, string>): Promise<readonly Tier[]> {
  const response = await fetch(`${baseURL}/meta`, { headers, signal: AbortSignal.timeout(5_000) })
  if (response.status === 404 || response.status === 405) return tiers
  if (!response.ok) throw new Error(`Copilot auto tier discovery failed: ${response.status}`)
  const metadata = decodeMetadata(await response.json())
  return tiers.filter((tier) =>
    metadata.auto?.tiers.some((item) => item.id === tier && item.type === "auto" && item.status.enabled),
  )
}

/** Asks Copilot's auto router which model should serve a prompt. */
export async function route(
  baseURL: string,
  headers: Record<string, string>,
  input: { readonly prompt: string; readonly image: boolean; readonly tier?: Tier },
  signal?: AbortSignal,
): Promise<Route> {
  const response = await fetch(`${baseURL}/auto`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: input.prompt,
      ...(input.image ? { has_image: true } : {}),
      ...(input.tier
        ? { tier: input.tier, multi_turn: { routing_intent: "anchor", turns_since_anchor: 0 }, hydra_rl_multi_turn: {} }
        : {}),
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error(`Copilot auto routing failed: ${response.status}`)
  const body = decodeResponse(await response.json())
  return {
    model: body.selected_model.id,
    token: body.session_token,
    until: body.expires_at * 1000 - refreshMargin,
  }
}
