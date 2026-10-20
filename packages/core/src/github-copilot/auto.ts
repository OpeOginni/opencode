export * as CopilotAuto from "./auto.js"

import { Option, Schema } from "effect"

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

const MultiTurn = Schema.Struct({
  state_token: Schema.NonEmptyString,
  skip_turns: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
const Response = Schema.Struct({
  session_token: Schema.String,
  expires_at: Schema.optional(Schema.Finite),
  selected_model: Schema.Struct({ id: Schema.String }),
  hydra_rl_multi_turn: Schema.optional(MultiTurn),
})
const decodeResponse = Schema.decodeUnknownSync(Response)
const Session = Schema.Struct({
  available_models: Schema.Array(Schema.String),
  selected_model: Schema.String,
  session_token: Schema.String,
  expires_at: Schema.Finite,
})
const decodeSession = Schema.decodeUnknownSync(Session)
const decodeIntent = Schema.decodeUnknownSync(Schema.Struct({ chosen_model: Schema.optional(Schema.String) }))
const decodeExpiry = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ exp: Schema.Finite })))

/** A prompt's routed model. `token` unlocks auto-only models and the auto discount on paid plans. */
export interface Route {
  readonly model: string
  readonly token: string
  /** Epoch milliseconds after which the model/token pair must be refreshed. */
  readonly until: number
  readonly state?: typeof MultiTurn.Type
}

const refreshMargin = 30_000

export async function loadTiers(baseURL: string, headers: Record<string, string>): Promise<readonly Tier[]> {
  const response = await fetch(`${baseURL}/meta`, { headers, signal: AbortSignal.timeout(5_000) })
  if (response.status === 404 || response.status === 405) return tiers
  if (!response.ok) throw new Error(`Copilot auto tier discovery failed: ${response.status}`)
  const metadata = decodeMetadata(await response.json())
  return tiers.filter((tier) =>
    metadata.auto?.tiers.some((item) => item.id === tier && item.type === "auto" && item.status.enabled),
  )
}

export class Router {
  private session?: Promise<typeof Session.Type>

  constructor(
    private readonly baseURL: string,
    private readonly headers: Record<string, string>,
  ) {}

  async route(
    input: { readonly prompt: string; readonly image: boolean; readonly tier?: Tier; readonly state?: string },
    signal?: AbortSignal,
  ): Promise<Route> {
    const response = await this.request(
      "/auto",
      {
        prompt: input.prompt,
        has_image: input.image,
        ...(input.tier ? { tier: input.tier } : {}),
        ...(input.state ? {} : { multi_turn: { routing_intent: "anchor", turns_since_anchor: 0 } }),
        hydra_rl_multi_turn: input.state ? { state_token: input.state } : {},
      },
      signal,
    )
    if (response === undefined) {
      if (input.tier) throw new Error(`Copilot Auto tier '${input.tier}' is unsupported by this deployment`)
      const session = await this.getSession(signal)
      const body = decodeIntent(
        await this.request(
          "/models/session/intent",
          {
            prompt: input.prompt,
            available_models: session.available_models,
            has_image: input.image,
            routing_intent: "anchor",
            turns_since_anchor: 0,
          },
          signal,
          { "Copilot-Session-Token": session.session_token },
        ),
      )
      return {
        model: body.chosen_model ?? session.selected_model,
        token: session.session_token,
        until: session.expires_at * 1000 - refreshMargin,
      }
    }
    const body = decodeResponse(response)
    const expiry = Option.getOrUndefined(
      decodeExpiry(Buffer.from(body.session_token.split(".")[1] ?? "", "base64url").toString()),
    )
    const until = (body.expires_at ?? expiry?.exp ?? Date.now() / 1000 + 300) * 1000
    if (!body.selected_model.id.trim() || !body.session_token.trim())
      throw new Error("Copilot Auto returned an invalid model/token pair")
    if (until <= Date.now()) throw new Error("Copilot Auto returned an expired session token")
    return {
      model: body.selected_model.id,
      token: body.session_token,
      until: until - refreshMargin,
      state: body.hydra_rl_multi_turn,
    }
  }

  private async getSession(signal?: AbortSignal): Promise<typeof Session.Type> {
    if (this.session) {
      const session = await this.session
      if (session.expires_at * 1000 > Date.now() + refreshMargin) return session
    }
    this.session = this.request("/models/session", { auto_mode: { model_hints: ["auto"] } }, signal)
      .then(decodeSession)
      .catch((error: unknown) => {
        this.session = undefined
        throw error
      })
    return this.session
  }

  private async request(path: string, body: Schema.Json, signal?: AbortSignal, headers?: Record<string, string>) {
    const response = await fetch(`${this.baseURL}${path}`, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000),
    })
    if (path === "/auto" && (response.status === 404 || response.status === 405)) return
    if (!response.ok) throw new Error(`Copilot auto routing failed (${path}): ${response.status}`)
    return response.json()
  }
}
