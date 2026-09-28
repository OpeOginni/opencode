import { isPermissionDenied } from "@opencode/util/platform-error"
import { Effect, FileSystem } from "effect"

export const makeDefaultProject = Effect.fn("Onboarding.makeDefaultProject")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const denied = yield* fs.makeDirectory(directory, { recursive: true }).pipe(
    Effect.as(false),
    Effect.catchTag("PlatformError", (error) => (isPermissionDenied(error) ? Effect.succeed(true) : Effect.fail(error))),
  )
  return denied ? { permissionDenied: directory } : directory
})
