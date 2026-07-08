export * as MoveSession from "./move-session"

import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { Git } from "../git"
import { Location } from "../location"
import { ProjectV2 } from "../project"
import { SessionV2 } from "../session"
import { SessionEvent } from "../session/event"
import { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { Database } from "../database/database"
import { WorkspaceTable } from "./workspace.sql"
import { AbsolutePath, RelativePath, optional } from "../schema"
import { WorkspaceV2 } from "../workspace"
import { eq } from "drizzle-orm"
import path from "path"

export const Destination = Schema.Struct({
  directory: AbsolutePath,
  workspaceID: optional(WorkspaceV2.ID),
}).annotate({ identifier: "MoveSession.Destination" })
export type Destination = typeof Destination.Type

export const Input = Schema.Struct({
  sessionID: SessionSchema.ID,
  destination: Destination,
  moveChanges: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "MoveSession.Input" })
export type Input = typeof Input.Type

export class DestinationProjectMismatchError extends Schema.TaggedErrorClass<DestinationProjectMismatchError>()(
  "MoveSession.DestinationProjectMismatchError",
  {
    expected: ProjectV2.ID,
    actual: ProjectV2.ID,
  },
) {}

export class ApplyChangesError extends Schema.TaggedErrorClass<ApplyChangesError>()("MoveSession.ApplyChangesError", {
  message: Schema.String,
}) {}

export class CaptureChangesError extends Schema.TaggedErrorClass<CaptureChangesError>()(
  "MoveSession.CaptureChangesError",
  {
    message: Schema.String,
  },
) {}

export class ResetSourceChangesError extends Schema.TaggedErrorClass<ResetSourceChangesError>()(
  "MoveSession.ResetSourceChangesError",
  {
    directory: AbsolutePath,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class DestinationWorkspaceNotFoundError extends Schema.TaggedErrorClass<DestinationWorkspaceNotFoundError>()(
  "MoveSession.DestinationWorkspaceNotFoundError",
  {
    workspaceID: WorkspaceV2.ID,
  },
) {}

export class WorkspaceChangeTransferUnsupportedError extends Schema.TaggedErrorClass<WorkspaceChangeTransferUnsupportedError>()(
  "MoveSession.WorkspaceChangeTransferUnsupportedError",
  {
    source: Schema.NullOr(WorkspaceV2.ID),
    destination: Schema.NullOr(WorkspaceV2.ID),
  },
) {}

export type Error =
  | SessionV2.NotFoundError
  | DestinationProjectMismatchError
  | CaptureChangesError
  | ApplyChangesError
  | ResetSourceChangesError
  | DestinationWorkspaceNotFoundError
  | WorkspaceChangeTransferUnsupportedError

export interface Interface {
  readonly moveSession: (input: Input) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ControlPlaneMoveSession") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const git = yield* Git.Service
    const events = yield* EventV2.Service
    const project = yield* ProjectV2.Service
    const sessions = yield* SessionStore.Service
    const { db } = yield* Database.Service

    const moveSession = Effect.fn("MoveSession.moveSession")(function* (input: Input) {
      const current = yield* sessions.get(input.sessionID)
      if (!current) return yield* new SessionV2.NotFoundError({ sessionID: input.sessionID })
      const directory = AbsolutePath.make(input.destination.directory)
      if (current.location.directory === directory && current.location.workspaceID === input.destination.workspaceID) return

      const destination = input.destination.workspaceID
        ? yield* db
            .select({ id: WorkspaceTable.id, projectID: WorkspaceTable.project_id, directory: WorkspaceTable.directory })
            .from(WorkspaceTable)
            .where(eq(WorkspaceTable.id, input.destination.workspaceID))
            .get()
            .pipe(Effect.orDie)
        : yield* project.resolve(directory).pipe(
            Effect.map((resolved) => ({ id: undefined, projectID: resolved.id, directory: resolved.directory })),
          )
      if (!destination && input.destination.workspaceID)
        return yield* new DestinationWorkspaceNotFoundError({ workspaceID: input.destination.workspaceID })
      if (!destination) return yield* new ApplyChangesError({ message: "Destination workspace not found" })
      if (current.projectID !== destination.projectID)
        return yield* new DestinationProjectMismatchError({ expected: current.projectID, actual: destination.projectID })

      const sourceWorkspaceID = current.location.workspaceID
      const destinationWorkspaceID = input.destination.workspaceID
      if (input.moveChanges && (sourceWorkspaceID || destinationWorkspaceID))
        return yield* new WorkspaceChangeTransferUnsupportedError({
          source: sourceWorkspaceID ?? null,
          destination: destinationWorkspaceID ?? null,
        })

      const source = input.moveChanges ? yield* project.resolve(current.location.directory) : undefined
      const moveChanges = input.moveChanges && source?.directory !== destination.directory
      const sourceRepository = moveChanges ? yield* git.repo.discover(current.location.directory) : undefined
      if (moveChanges && !sourceRepository)
        return yield* new CaptureChangesError({ message: "Source is not a Git repository" })
      const patch = sourceRepository
        ? yield* git.change
            .capture({ repository: sourceRepository, path: current.location.directory })
            .pipe(Effect.mapError((error) => new CaptureChangesError({ message: error.message })))
        : Git.ChangeSet.make("")
      if (patch) {
        const repository = yield* git.repo.discover(directory)
        if (!repository) return yield* new ApplyChangesError({ message: "Destination is not a Git repository" })
        yield* git.change
          .apply({ repository, path: directory, changes: patch })
          .pipe(Effect.mapError((error) => new ApplyChangesError({ message: error.message })))
      }

      yield* events.publish(SessionEvent.Moved, {
        sessionID: input.sessionID,
        location: Location.Ref.make({ directory, workspaceID: input.destination.workspaceID }),
        subdirectory: RelativePath.make(path.relative(destination.directory ?? directory, directory).replaceAll("\\", "/")),
        timestamp: yield* DateTime.now,
      })

      if (patch) {
        const repository = yield* git.repo.discover(current.location.directory)
        if (!repository)
          return yield* new ResetSourceChangesError({
            directory: current.location.directory,
            message: "Source is not a Git repository",
          })
        yield* git.change
          .discard({
            repository,
            path: current.location.directory,
            index: "preserve",
            untracked: "remove",
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new ResetSourceChangesError({
                  directory: current.location.directory,
                  message: error.message,
                  cause: error.cause,
                }),
            ),
          )
      }
    })

    return Service.of({ moveSession })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Git.node, EventV2.node, ProjectV2.node, SessionStore.node, Database.node],
})
