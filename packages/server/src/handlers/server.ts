import { Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { ServerInfo } from "../server-info"
import { ServerPairing } from "../pairing"
import { ServerAuth } from "../auth"

export const ServerHandler = HttpApiBuilder.group(Api, "server.server", (handlers) =>
  handlers
    .handle("server.get", () =>
      Effect.gen(function* () {
        const info = yield* ServerInfo.Service
        return { urls: info.urls() }
      }),
    )
    .handle("server.pairing.create", () =>
      Effect.gen(function* () {
        const pairing = yield* ServerPairing.Service
        return yield* pairing.issue
      }),
    )
    .handle("server.pairing.redeem", ({ payload }) =>
      Effect.gen(function* () {
        const pairing = yield* ServerPairing.Service
        yield* pairing.redeem(payload.ticket)
        const auth = yield* ServerAuth.Config
        return { username: auth.username, password: Option.getOrElse(auth.password, () => "") }
      }),
    ),
)
