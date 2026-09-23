import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { InvalidRequestError, LocationPermissionDeniedError } from "@opencode/protocol/errors"
import { FSUtil } from "@opencode/util/fs-util"
import type { PlatformError } from "effect/PlatformError"
import { Effect, Layer, Schema } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { missingSession } from "./handlers/session-error"

export type LocationServices = Layer.Success<ReturnType<(typeof LocationServiceMap.Service)["get"]>>

export class LocationMiddleware extends HttpApiMiddleware.Service<
  LocationMiddleware,
  { provides: LocationServices }
>()("@opencode/HttpApiLocation", { error: LocationPermissionDeniedError }) {}

export function response<A, E, R>(data: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const location = yield* Location.Service
    return {
      location: new Location.Info({
        directory: location.directory,
        project: location.project,
      }),
      data: yield* data,
    }
  })
}

const decodeSessionID = Schema.decodeUnknownEffect(Session.ID)

export const sessionInfo = Effect.fnUntraced(function* (sessions: Session.Interface, sessionID: unknown) {
  const id = yield* decodeSessionID(sessionID).pipe(
    Effect.mapError(() => new InvalidRequestError({ message: "Invalid session ID", field: "sessionID" })),
  )
  return yield* sessions.get(id).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
})

export function requestRef(request: HttpServerRequest.HttpServerRequest): Location.Ref {
  const query = new URL(request.url, "http://localhost").searchParams
  const directory =
    query.get("location[directory]") ||
    (request.headers["x-opencode-directory"] ? decode(request.headers["x-opencode-directory"]) : process.cwd())
  return Location.Ref.make({
    directory: AbsolutePath.make(directory),
  })
}

function decode(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

export const layer = (permissionCheck = true) =>
  Layer.effect(
    LocationMiddleware,
    Effect.gen(function* () {
      const locations = yield* LocationServiceMap.Service
      const fs = yield* FSUtil.Service
      return LocationMiddleware.of((effect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const ref = requestRef(request)
          if (permissionCheck)
            yield* fs.realPath(ref.directory).pipe(
              Effect.catchTag("PlatformError", (error) => {
                if (isPermissionDenied(error))
                  return Effect.fail(
                    new LocationPermissionDeniedError({
                      directory: ref.directory,
                      message: `Cannot access project directory: ${ref.directory}`,
                    }),
                  )
                return Effect.die(error)
              }),
            )
          return yield* effect.pipe(Effect.provide(locations.get(ref)))
        }),
      )
    }),
  )

// macOS can report EPERM as a PlatformError with reason Unknown instead of PermissionDenied.
export function isPermissionDenied(error: PlatformError) {
  if (error.reason._tag === "PermissionDenied") return true
  const cause = error.cause
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause.code === "EPERM" || cause.code === "EACCES")
  )
}
