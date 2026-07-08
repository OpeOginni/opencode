import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { SessionV2 } from "@opencode-ai/core/session"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Workspace } from "@/control-plane/workspace"
import { RootHttpApi } from "../api"
import { ApiMoveSessionError, MoveSessionPayload } from "../groups/control-plane"

export const controlPlaneHandlers = HttpApiBuilder.group(RootHttpApi, "controlPlane", (handlers) =>
  Effect.gen(function* () {
    const service = yield* MoveSession.Service

    const moveSession = Effect.fn("ControlPlaneHttpApi.moveSession")(function* (ctx: {
      payload: typeof MoveSessionPayload.Type
    }) {
      if (!ctx.payload.destination.workspaceID) {
        const moved = yield* service.moveSession(ctx.payload).pipe(
          Effect.as(true),
          Effect.catch((error) => {
            if (error instanceof MoveSession.WorkspaceChangeTransferUnsupportedError) return Effect.succeed(false)
            return Effect.fail(
              new ApiMoveSessionError({
                name: "MoveSessionError",
                data: { message: message(error) },
              }),
            )
          }),
        )
        if (moved) return

        const workspace = yield* Workspace.Service
        yield* workspace
          .moveSession({
            sessionID: ctx.payload.sessionID,
            workspaceID: null,
            copyChanges: ctx.payload.moveChanges,
          })
          .pipe(Effect.mapError((error) => new ApiMoveSessionError({ name: "MoveSessionError", data: { message: error.message } })))
        yield* service.moveSession({ ...ctx.payload, moveChanges: false }).pipe(
          Effect.mapError(
            (error) => new ApiMoveSessionError({ name: "MoveSessionError", data: { message: message(error) } }),
          ),
        )
        return
      }

      const workspace = yield* Workspace.Service
      yield* workspace
        .moveSession({
          sessionID: ctx.payload.sessionID,
          workspaceID: ctx.payload.destination.workspaceID,
          copyChanges: ctx.payload.moveChanges,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new ApiMoveSessionError({
                name: "MoveSessionError",
                data: { message: error.message },
              }),
          ),
        )

      yield* service.moveSession({ ...ctx.payload, moveChanges: false }).pipe(
        Effect.mapError(
          (error) =>
            new ApiMoveSessionError({
              name: "MoveSessionError",
              data: { message: message(error) },
            }),
        ),
      )
    })

    return handlers.handle("moveSession", moveSession)
  }),
)

function message(error: MoveSession.Error) {
  if (error instanceof SessionV2.NotFoundError) return `Session not found: ${error.sessionID}`
  if (error instanceof MoveSession.DestinationProjectMismatchError)
    return "Destination directory belongs to another project"
  if (error instanceof MoveSession.DestinationWorkspaceNotFoundError)
    return `Destination workspace not found: ${error.workspaceID}`
  if (error instanceof MoveSession.WorkspaceChangeTransferUnsupportedError)
    return "Moving changes between workspaces is not supported yet"
  if (error instanceof MoveSession.ApplyChangesError)
    return `Unable to apply your changes in the destination directory. The files may conflict with existing changes.`
  return error.message
}
