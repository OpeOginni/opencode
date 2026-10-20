export * as SessionRunnerModel from "./model.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { HttpOptions, LanguageModel, mergeHttpOptions } from "@opencode/ai"
import { Provider } from "../../provider.js"
import { Context, Effect, Layer, Schema } from "effect"
import { Model } from "../../model.js"
import { ModelResolver } from "../../model-resolver.js"
import { PluginHooks } from "../../plugin/hooks.js"
import { SessionSchema } from "../schema.js"

export class ModelNotSelectedError extends Schema.TaggedError<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  { sessionID: SessionSchema.ID },
) {
  override get message() {
    return `No model is available for session ${this.sessionID}`
  }
}

export class ModelUnavailableError extends Schema.TaggedError<ModelUnavailableError>()(
  "SessionRunnerModel.ModelUnavailableError",
  { providerID: Provider.ID, modelID: Model.ID },
) {
  override get message() {
    if (this.providerID === "azure-cognitive-services")
      return `Model unavailable: ${this.providerID}/${this.modelID}. This provider has been deprecated; use azure/${this.modelID} instead.`
    if (this.providerID === "google-vertex-anthropic")
      return `Model unavailable: ${this.providerID}/${this.modelID}. This provider has been deprecated; use google-vertex/${this.modelID} instead.`
    return `Model unavailable: ${this.providerID}/${this.modelID}`
  }
}
export type Error = ModelNotSelectedError | ModelUnavailableError | ModelResolver.Error
export type Resolved = ModelResolver.Resolved

export interface Interface {
  /** Availability is sampled lazily for each explicitly selected model resolution. */
  readonly resolve: (
    session: SessionSchema.Info,
    available: () => Effect.Effect<ReadonlyArray<Model.Info>>,
  ) => Effect.Effect<Resolved, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunnerModel") {}

/** Builds a Resolved whose catalog identity mirrors the route model. Test or embedding seam. */
export const resolved = (
  model: LanguageModel,
  options: {
    readonly capabilities: Model.Capabilities
    readonly variant?: Model.VariantID
    readonly cost: Model.Info["cost"]
    readonly limit: Model.Info["limit"]
    readonly compaction?: Provider.Compaction
    readonly transport?: Provider.Transport
  },
): Resolved => ({
  model,
  ref: Model.Ref.make({
    id: Model.ID.make(model.id),
    providerID: Provider.ID.make(model.provider),
    ...(options.variant === undefined ? {} : { variant: options.variant }),
  }),
  capabilities: options.capabilities,
  cost: options.cost,
  limit: options.limit,
  compaction: options.compaction,
  transport: options.transport,
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const resolver = yield* ModelResolver.Service
    const catalog = yield* Model.Service
    const hooks = yield* PluginHooks.Service
    const select = Effect.fn("SessionRunnerModel.select")(function* (
      session: SessionSchema.Info,
      available: () => Effect.Effect<ReadonlyArray<Model.Info>>,
    ) {
      // Location plugins populate and filter the catalog asynchronously during layer startup.
      if (!session.model) {
        const resolved = yield* resolver.resolve()
        if (resolved) return resolved
        return yield* new ModelNotSelectedError({ sessionID: session.id })
      }
      const selected = (yield* available()).find(
        (model) => model.providerID === session.model?.providerID && model.id === session.model.id,
      )
      if (!selected)
        return yield* new ModelUnavailableError({
          providerID: session.model.providerID,
          modelID: session.model.id,
        })
      return yield* resolver.resolveModel(selected, session.model.variant)
    })
    return Service.of({
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session, available) {
        const selected = yield* select(session, available)
        const event = yield* hooks.trigger("session", "model.resolve", { sessionID: session.id, model: selected.ref })
        if (event.error !== undefined)
          return yield* new ModelResolver.ModelConfigurationError({
            providerID: selected.ref.providerID,
            modelID: selected.ref.id,
            package: selected.model.route.id,
            detail: event.error,
          })
        const targetID = event.target ?? selected.ref.id
        const target = targetID === selected.ref.id ? undefined : yield* catalog.get(selected.ref.providerID, targetID)
        if (targetID !== selected.ref.id && !target)
          return yield* new ModelUnavailableError({
            providerID: selected.ref.providerID,
            modelID: targetID,
          })
        const resolved = target ? yield* resolver.resolveModel(target) : selected
        return {
          ...resolved,
          cost: event.cost ?? resolved.cost,
          model:
            event.headers === undefined
              ? resolved.model
              : LanguageModel.update(resolved.model, {
                  defaults: {
                    ...resolved.model.defaults,
                    http: mergeHttpOptions(resolved.model.defaults?.http, new HttpOptions({ headers: event.headers })),
                  },
                }),
        }
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [ModelResolver.node, Model.node, PluginHooks.node],
})
