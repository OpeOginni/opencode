import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { UnauthorizedError } from "../errors.js"

const PAIRING_REDEEM_PATH = "/api/server/pairing/redeem"

export function isServerPairingRedeemRequest(method: string, url: URL) {
  return method === "POST" && url.pathname === PAIRING_REDEEM_PATH
}

export const ServerGroup = HttpApiGroup.make("server.server")
  .add(
    HttpApiEndpoint.get("server.get", "/api/server", {
      success: Schema.Struct({ urls: Schema.Array(Schema.String) }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.server.get",
        summary: "Get server information",
        description: "Return the URLs that can be used to connect to this server.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("server.pairing.create", "/api/server/pairing", {
      success: Schema.Struct({ ticket: Schema.String, expiresAt: Schema.Number }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.server.pairing.create",
        summary: "Create pairing ticket",
        description: "Create a short-lived, single-use ticket for pairing another client.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("server.pairing.redeem", PAIRING_REDEEM_PATH, {
      payload: Schema.Struct({ ticket: Schema.String }),
      success: Schema.Struct({ username: Schema.String, password: Schema.String }),
      error: UnauthorizedError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.server.pairing.redeem",
        summary: "Redeem pairing ticket",
        description: "Consume a pairing ticket and return the server credentials.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "server" }))
