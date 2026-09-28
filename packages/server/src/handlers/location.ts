import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { checkDirectory } from "@opencode/core/location-services"
import { ServiceUnavailableError } from "@opencode/protocol/errors"
import { Cause, Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { DirectoryCheck, locationError } from "../location"
import { FSUtil } from "@opencode/util/fs-util"

export const LocationHandler = HttpApiBuilder.group(Api, "server.location", (handlers) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const fs = yield* FSUtil.Service
    const directoryCheck = yield* DirectoryCheck
    return handlers
      .handle(
        "location.get",
        Effect.fn(function* () {
          const location = yield* Location.Service
          // Clients call this to check a folder before using it. A cached Location can outlive its folder,
          // and its boot-time check does not run again.
          if (directoryCheck && !location.workspaceID)
            yield* checkDirectory(fs, location.directory).pipe(Effect.mapError(locationError))
          return new Location.Info({
            directory: location.directory,
            project: location.project,
          })
        }),
      )
      .handle("location.reload", () =>
        LocationServiceMap.reload().pipe(
          Effect.provideService(LocationServiceMap.Service, locations),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.fail(new ServiceUnavailableError({ message: Cause.pretty(cause), service: "location" })),
          ),
        ),
      )
  }),
)
