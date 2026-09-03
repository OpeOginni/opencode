export * as ServerPairing from "./pairing"

import { UnauthorizedError } from "@opencode-ai/protocol/errors"
import { Context, Effect, Encoding, Layer } from "effect"

const ttl = 2 * 60 * 1000

export class Service extends Context.Service<
  Service,
  {
    readonly issue: Effect.Effect<{ ticket: string; expiresAt: number }>
    readonly redeem: (ticket: string) => Effect.Effect<void, UnauthorizedError>
  }
>()("@opencode/ServerPairing") {}

export const layer = Layer.sync(Service, () => {
  const tickets = new Map<string, number>()
  return Service.of({
    issue: Effect.sync(() => {
      const now = Date.now()
      tickets.forEach((expiresAt, ticket) => {
        if (expiresAt <= now) tickets.delete(ticket)
      })
      const ticket = Encoding.encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))
      const expiresAt = now + ttl
      tickets.set(ticket, expiresAt)
      return { ticket, expiresAt }
    }),
    redeem: (ticket) =>
      Effect.gen(function* () {
        const expiresAt = tickets.get(ticket)
        if (expiresAt === undefined || expiresAt <= Date.now()) {
          if (expiresAt !== undefined) tickets.delete(ticket)
          return yield* new UnauthorizedError({ message: "Invalid or expired pairing ticket" })
        }
        tickets.delete(ticket)
        return
      }),
  })
})
