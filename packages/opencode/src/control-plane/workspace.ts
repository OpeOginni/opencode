import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Cause, Context, Effect, FiberMap, Iterable, Layer, Schema, Stream, SynchronizedRef } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { FetchHttpClient, HttpBody, HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http"
import { Database } from "@opencode-ai/core/database/database"
import { and, asc, desc } from "drizzle-orm"
import { eq } from "drizzle-orm"
import { inArray } from "drizzle-orm"
import { Project } from "@/project/project"
import { GlobalBus } from "@/bus/global"
import { Auth } from "@/auth"
import { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Slug } from "@opencode-ai/core/util/slug"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { getAdapter, registeredAdapters } from "./adapters"
import { type Target, type WorkspaceInfo, WorkspaceInfo as WorkspaceInfoSchema } from "./types"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionID } from "@/session/schema"
import { NotFoundError } from "@/storage/storage"
import { errorData } from "@/util/error"
import { waitEvent } from "./util"
import { WorkspaceRef } from "@/effect/instance-ref"
import { Vcs } from "@/project/vcs"
import { InstanceStore } from "@/project/instance-store"
import { WorkspaceAdapterRuntime } from "./workspace-adapter-runtime"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
import { WorkspaceEvent } from "@opencode-ai/schema/workspace-event"

export const Info = Schema.Struct({
  ...WorkspaceInfoSchema.fields,
  timeUsed: Schema.Number,
}).annotate({ identifier: "Workspace" })
export type Info = WorkspaceInfo & { timeUsed: number }

export const ConnectionStatus = WorkspaceEvent.ConnectionStatus
export type ConnectionStatus = WorkspaceEvent.ConnectionStatus

export const Event = WorkspaceEvent

function fromRow(row: typeof WorkspaceTable.$inferSelect): Info {
  return {
    id: row.id,
    type: row.type,
    branch: row.branch,
    name: row.name,
    directory: row.directory,
    extra: jsonExtra(row.extra),
    projectID: row.project_id,
    timeUsed: row.time_used,
  }
}

export const CreateInput = Schema.Struct({
  id: Schema.optional(WorkspaceV2.ID),
  type: Info.fields.type,
  branch: Info.fields.branch,
  projectID: ProjectV2.ID,
  extra: Schema.optional(Info.fields.extra),
})
export type CreateInput = Schema.Schema.Type<typeof CreateInput>

export const MoveSessionInput = Schema.Struct({
  workspaceID: Schema.NullOr(WorkspaceV2.ID),
  destinationDirectory: Schema.optional(Schema.String),
  sessionID: SessionID,
  copyChanges: Schema.optional(Schema.Boolean),
})
export type MoveSessionInput = Schema.Schema.Type<typeof MoveSessionInput>

export class SyncHttpError extends Schema.TaggedErrorClass<SyncHttpError>()("WorkspaceSyncHttpError", {
  message: Schema.String,
  status: Schema.Number,
  body: Schema.optional(Schema.String),
}) {}

export class WorkspaceNotFoundError extends Schema.TaggedErrorClass<WorkspaceNotFoundError>()(
  "WorkspaceNotFoundError",
  {
    message: Schema.String,
    workspaceID: WorkspaceV2.ID,
  },
) {}

export class WorkspaceNotReadyError extends Schema.TaggedErrorClass<WorkspaceNotReadyError>()(
  "WorkspaceNotReadyError",
  {
    message: Schema.String,
    workspaceID: WorkspaceV2.ID,
  },
) {}

export class MoveSessionHttpError extends Schema.TaggedErrorClass<MoveSessionHttpError>()(
  "WorkspaceMoveSessionHttpError",
  {
    message: Schema.String,
    workspaceID: WorkspaceV2.ID,
    sessionID: SessionID,
    status: Schema.Number,
    body: Schema.String,
  },
) {}

export class ChangeTransferError extends Schema.TaggedErrorClass<ChangeTransferError>()(
  "WorkspaceChangeTransferError",
  {
    message: Schema.String,
  },
) {}

export class SyncTimeoutError extends Schema.TaggedErrorClass<SyncTimeoutError>()("WorkspaceSyncTimeoutError", {
  message: Schema.String,
  state: Schema.Record(Schema.String, Schema.Number),
}) {}

export class SyncAbortedError extends Schema.TaggedErrorClass<SyncAbortedError>()("WorkspaceSyncAbortedError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

type CreateError = Auth.AuthError
type MoveSessionError =
  | WorkspaceNotFoundError
  | WorkspaceNotReadyError
  | MoveSessionHttpError
  | ChangeTransferError
  | Vcs.PatchApplyError
  | Vcs.DiscardError
  | HttpClientError.HttpClientError
  | MoveSession.Error
type WaitForSyncError = SyncTimeoutError | SyncAbortedError
type SyncLoopError = SyncHttpError | HttpClientError.HttpClientError
type EnsureReadyError = WorkspaceNotFoundError | WorkspaceNotReadyError

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Info, CreateError>
  readonly moveSession: (input: MoveSessionInput) => Effect.Effect<void, MoveSessionError>
  readonly list: (project: Project.Info) => Effect.Effect<Info[]>
  readonly syncList: (project: Project.Info) => Effect.Effect<void>
  readonly get: (id: WorkspaceV2.ID) => Effect.Effect<Info | undefined>
  readonly remove: (id: WorkspaceV2.ID) => Effect.Effect<Info | undefined>
  readonly status: () => Effect.Effect<ConnectionStatus[]>
  readonly ensureReady: (workspaceID: WorkspaceV2.ID) => Effect.Effect<void, EnsureReadyError>
  readonly isSyncing: (workspaceID: WorkspaceV2.ID) => Effect.Effect<boolean>
  readonly waitForSync: (
    workspaceID: WorkspaceV2.ID,
    state: Record<string, number>,
    signal?: AbortSignal,
    timeout?: number,
  ) => Effect.Effect<void, WaitForSyncError>
  readonly startWorkspaceSyncing: (projectID: ProjectV2.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Workspace") {}

export const use = serviceUse(Service)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const session = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const mover = yield* MoveSession.Service
    const http = yield* HttpClient.HttpClient
    const events = yield* EventV2Bridge.Service
    const vcs = yield* Vcs.Service
    const flags = yield* RuntimeFlags.Service
    const fs = yield* FSUtil.Service
    const { db } = yield* Database.Service
    const connections = new Map<WorkspaceV2.ID, ConnectionStatus>()
    const settledConnections = new Map<WorkspaceV2.ID, ConnectionStatus["status"]>()
    const readiness = yield* SynchronizedRef.make(new Map<WorkspaceV2.ID, Effect.Effect<void, EnsureReadyError>>())
    const syncFibers = yield* FiberMap.make<WorkspaceV2.ID, void, SyncLoopError>()

    const remoteMoveRequest = (
      request: HttpClientRequest.HttpClientRequest,
      meta: { workspaceID: WorkspaceV2.ID; sessionID: SessionID; step: string },
    ) =>
      http.execute(request).pipe(
        Effect.timeout(REMOTE_MOVE_HTTP_TIMEOUT),
        Effect.catchIf(Cause.isTimeoutError, () =>
          Effect.fail(
            new MoveSessionHttpError({
              message: `Timed out during ${meta.step} for session ${meta.sessionID} in workspace ${meta.workspaceID}`,
              workspaceID: meta.workspaceID,
              sessionID: meta.sessionID,
              status: 504,
              body: "timeout",
            }),
          ),
        ),
      )

    const setStatus = (id: WorkspaceV2.ID, status: ConnectionStatus["status"]) => {
      const prev = connections.get(id)
      if (prev?.status === status) return
      const next = { workspaceID: id, status }
      connections.set(id, next)
      if (status === "connected" || status === "paused" || status === "error") settledConnections.set(id, status)

      GlobalBus.emit("event", {
        directory: "global",
        workspace: id,
        payload: {
          type: Event.Status.type,
          properties: next,
        },
      })
    }

    const waitForConnection = (
      workspaceID: WorkspaceV2.ID,
      settled: ReadonlySet<ConnectionStatus["status"]>,
      timeout = TIMEOUT,
    ): Effect.Effect<void, WorkspaceNotReadyError> => {
      const deadline = Date.now() + timeout
      const loop = (): Effect.Effect<void, WorkspaceNotReadyError> =>
        Effect.suspend(() => {
          const status = settledConnections.get(workspaceID)
          if (status && settled.has(status)) return Effect.void
          if (Date.now() >= deadline)
            return Effect.fail(
              new WorkspaceNotReadyError({
                message: `Timed out waiting for workspace ${workspaceID}`,
                workspaceID,
              }),
            )
          return Effect.sleep("10 millis").pipe(Effect.andThen(loop()))
        })
      return loop()
    }

    const connectSSE = Effect.fn("Workspace.connectSSE")(function* (
      url: URL | string,
      headers: HeadersInit | undefined,
    ) {
      const response = yield* http.execute(
        HttpClientRequest.get(route(url, "/global/event"), {
          headers: new Headers(headers),
          accept: "text/event-stream",
        }),
      )
      if (response.status < 200 || response.status >= 300) {
        return yield* new SyncHttpError({
          message: `Workspace sync HTTP failure: ${response.status}`,
          status: response.status,
        })
      }
      return response.stream
    })

    const parseSSE = Effect.fn("Workspace.parseSSE")(function* (
      stream: Stream.Stream<Uint8Array, unknown>,
      onEvent: (event: unknown) => Effect.Effect<void>,
    ) {
      yield* stream.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.mapAccum(
          () => ({ data: [] as string[], id: undefined as string | undefined, retry: 1000 }),
          (state, line) => {
            if (line === "") {
              if (!state.data.length) return [state, []]
              return [{ ...state, data: [] }, [{ data: state.data.join("\n"), id: state.id, retry: state.retry }]]
            }

            const index = line.indexOf(":")
            const field = index === -1 ? line : line.slice(0, index)
            const value = index === -1 ? "" : line.slice(index + (line[index + 1] === " " ? 2 : 1))

            if (field === "data") return [{ ...state, data: [...state.data, value] }, []]
            if (field === "id") return [{ ...state, id: value }, []]
            if (field === "retry") {
              const retry = Number.parseInt(value, 10)
              return [Number.isNaN(retry) ? state : { ...state, retry }, []]
            }
            return [state, []]
          },
          {
            onHalt: (state) =>
              state.data.length ? [{ data: state.data.join("\n"), id: state.id, retry: state.retry }] : [],
          },
        ),
        Stream.map((event) => {
          try {
            return JSON.parse(event.data) as unknown
          } catch {
            return {
              type: "sse.message",
              properties: {
                data: event.data,
                id: event.id || undefined,
                retry: event.retry,
              },
            }
          }
        }),
        Stream.runForEach(onEvent),
      )
    })

    const runInWorkspace = <A, E, R>(input: {
      workspaceID?: WorkspaceV2.ID
      directory?: string
      local: () => Effect.Effect<A, E, R>
      remote: (input: {
        workspace: Info
        target: Extract<Target, { type: "remote" }>
      }) => HttpClientRequest.HttpClientRequest
      fallback: A
      response?: "json" | "text"
    }) =>
      Effect.gen(function* () {
        if (!input.workspaceID) {
          if (!input.directory) return yield* input.local()
          const store = yield* InstanceStore.Service
          return yield* store.provide({ directory: input.directory }, input.local())
        }

        const workspace = yield* get(input.workspaceID)
        if (!workspace) return input.fallback

        if (!(yield* FiberMap.has(syncFibers, workspace.id))) yield* ensureReady(workspace.id)
        const target = yield* WorkspaceAdapterRuntime.target(workspace)

        if (target.type === "local") {
          const store = yield* InstanceStore.Service
          return yield* store.provide({ directory: target.directory }, input.local())
        }

        const response = yield* http.execute(input.remote({ workspace, target })).pipe(
          Effect.timeout(REMOTE_MOVE_HTTP_TIMEOUT),
          Effect.catch((error) =>
            Effect.logWarning("workspace target request failed", {
              workspaceID: workspace.id,
              error: errorData(error),
            }).pipe(Effect.as(undefined)),
          ),
        )
        if (!response) return input.fallback
        if (response.status < 200 || response.status >= 300) {
          const body = yield* response.text.pipe(Effect.catch(() => Effect.succeed("")))
          yield* Effect.logWarning("workspace target request failed", {
            workspaceID: workspace.id,
            status: response.status,
            body: body.slice(0, 500),
          })
          return input.fallback
        }

        const body = input.response === "text" ? response.text : response.json
        return yield* body.pipe(
          Effect.map((result) => result as A),
          Effect.catch((error) =>
            Effect.logWarning("workspace target response decode failed", {
              workspaceID: workspace.id,
              error: errorData(error),
            }).pipe(Effect.as(input.fallback)),
          ),
        )
      })

    const syncHistory = Effect.fn("Workspace.syncHistory")(function* (
      space: Info,
      url: URL | string,
      headers: HeadersInit | undefined,
    ) {
      const sessionIDs = (yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.workspace_id, space.id))
        .all()
        .pipe(Effect.orDie)).map((row) => row.id)
      const state = sessionIDs.length
        ? Object.fromEntries(
            (yield* db
              .select()
              .from(EventSequenceTable)
              .where(inArray(EventSequenceTable.aggregate_id, sessionIDs))
              .all()
              .pipe(Effect.orDie)).map((row) => [row.aggregate_id, row.seq]),
          )
        : {}

      const response = yield* http.execute(
        HttpClientRequest.post(route(url, "/sync/history"), {
          headers: new Headers(headers),
          body: HttpBody.jsonUnsafe(state),
        }),
      )

      if (response.status < 200 || response.status >= 300) {
        const body = yield* response.text
        return yield* new SyncHttpError({
          message: `Workspace history HTTP failure: ${response.status} ${body}`,
          status: response.status,
          body,
        })
      }

      const history = (yield* response.json) as HistoryEvent[]

      yield* Effect.forEach(
        history,
        (event) =>
          events
            .replay(
              {
                id: EventV2.ID.make(event.id),
                aggregateID: event.aggregate_id,
                seq: event.seq,
                type: event.type,
                data: event.data,
              },
              { publish: true, ownerID: space.id },
            )
            .pipe(Effect.provideService(WorkspaceRef, space.id)),
        { discard: true },
      )
    })

    const syncWorkspaceLoop = Effect.fn("Workspace.syncWorkspaceLoop")(function* (space: Info) {
      const target = yield* WorkspaceAdapterRuntime.target(space)

      if (target.type === "local") return

      let attempt = 0

      while (true) {
        const adapterStatus = yield* WorkspaceAdapterRuntime.status(space).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        )
        if (adapterStatus === "paused") {
          setStatus(space.id, "paused")
          return
        }
        setStatus(space.id, "connecting")

        const stream = yield* connectSSE(target.url, target.headers).pipe(
          Effect.tap(() => syncHistory(space, target.url, target.headers)),
          Effect.catch((err) =>
            Effect.gen(function* () {
              // Don't flip a healthy remote to error just because SSE/history
              // failed (common behind a proxy). Adapter status remains source of truth.
              const adapterStatus = yield* WorkspaceAdapterRuntime.status(space).pipe(
                Effect.catch(() => Effect.succeed(undefined)),
              )
              if (adapterStatus === "connected" || adapterStatus === "connecting" || adapterStatus === "paused") {
                setStatus(space.id, adapterStatus)
              } else {
                setStatus(space.id, "error")
              }
              yield* Effect.logWarning("failed to connect to global sync", {
                workspace: space.name,
                error: errorData(err),
              })
              return null
            }),
          ),
        )

        if (stream) {
          attempt = 0

          setStatus(space.id, "connected")

          yield* parseSSE(stream, (evt) =>
            Effect.gen(function* () {
              if (!evt || typeof evt !== "object" || !("payload" in evt)) return
              const payload = evt.payload as { type?: string; syncEvent?: EventV2.SerializedEvent }
              if (payload.type === "server.heartbeat") return

              if (payload.type === "sync" && payload.syncEvent) {
                const failed = yield* events.replay(payload.syncEvent, { publish: true, ownerID: space.id }).pipe(
                  Effect.as(false),
                  Effect.catchCause((error) =>
                    Effect.logWarning("failed to replay global event", error).pipe(
                      Effect.annotateLogs({ workspaceID: space.id }),
                      Effect.as(true),
                    ),
                  ),
                )
                if (failed) return
              }

              try {
                const event = evt as { directory?: string; project?: string; payload: unknown }
                GlobalBus.emit("event", {
                  directory: event.directory,
                  project: event.project,
                  workspace: space.id,
                  payload: event.payload,
                })
              } catch (error) {
                yield* Effect.logWarning("failed to emit global event", {
                  workspaceID: space.id,
                  error: errorData(error),
                })
              }
            }),
          )

          setStatus(space.id, "disconnected")
        }

        // Back off reconnect attempts up to 2 minutes while the workspace
        // stays unavailable.
        yield* Effect.sleep(`${Math.min(120_000, 1_000 * 2 ** attempt)} millis`)
        attempt += 1
      }
    })

    const startSync = Effect.fn("Workspace.startSync")(function* (space: Info) {
      const adapterStatus = yield* WorkspaceAdapterRuntime.status(space).pipe(
        Effect.catch((error) =>
          Effect.logWarning("workspace status failed", { workspaceID: space.id, error: errorData(error) }).pipe(
            Effect.as(undefined),
          ),
        ),
      )
      if (adapterStatus === "paused") {
        setStatus(space.id, "paused")
        return
      }
      // Prefer adapter runtime status for remote UX. SSE can lag/404 behind a
      // proxy while the remote workspace itself is healthy and move/proxy still work.
      if (adapterStatus === "connected" || adapterStatus === "connecting") {
        setStatus(space.id, adapterStatus)
      }

      if (!flags.experimentalWorkspaces && WorkspaceAdapterRuntime.kind(space) !== "local") return

      const target = yield* WorkspaceAdapterRuntime.target(space).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            setStatus(space.id, "error")
            yield* Effect.logWarning("workspace target failed", {
              workspaceID: space.id,
              error: errorData(error),
            })
            return null
          }),
        ),
      )
      if (!target) return

      if (target.type === "local") {
        setStatus(space.id, (yield* fs.existsSafe(target.directory)) ? "connected" : "error")
        return
      }

      const exists = yield* FiberMap.has(syncFibers, space.id)
      if (exists && connections.get(space.id)?.status !== "error") return

      if (connections.get(space.id)?.status !== "connected") setStatus(space.id, "disconnected")

      yield* FiberMap.run(
        syncFibers,
        space.id,
        // TODO: look into `tapError` to set the status but still
        // allow the fiber to fail and automatically get removed
        syncWorkspaceLoop(space).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              // Keep adapter-reported connected state if SSE dies; HTTP move still works.
              if (connections.get(space.id)?.status !== "connected") setStatus(space.id, "error")
              yield* Effect.logWarning("workspace listener failed", {
                workspaceID: space.id,
                error: errorData(error),
              })
            }),
          ),
        ),
      )
    })

    const stopSync = Effect.fn("Workspace.stopSync")(function* (id: WorkspaceV2.ID) {
      yield* FiberMap.remove(syncFibers, id)
      connections.delete(id)
      settledConnections.delete(id)
    })

    const create = Effect.fn("Workspace.create")(function* (input: CreateInput) {
      const id = WorkspaceV2.ID.ascending(input.id)
      const adapter = getAdapter(input.projectID, input.type)
      const config = yield* WorkspaceAdapterRuntime.configure(adapter, {
        ...input,
        id,
        name: Slug.create(),
        directory: null,
        extra: jsonExtra(input.extra),
      })

      const info: Info = {
        id,
        type: config.type,
        branch: config.branch ?? null,
        name: config.name ?? null,
        directory: config.directory ?? null,
        extra: jsonExtra(config.extra),
        projectID: input.projectID,
        timeUsed: Date.now(),
      }

      const env = {
        OPENCODE_AUTH_CONTENT: JSON.stringify(yield* auth.all()),
        OPENCODE_WORKSPACE_ID: config.id,
        OPENCODE_EXPERIMENTAL_WORKSPACES: "true",
        OTEL_EXPORTER_OTLP_HEADERS: process.env.OTEL_EXPORTER_OTLP_HEADERS,
        OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
        OTEL_RESOURCE_ATTRIBUTES: process.env.OTEL_RESOURCE_ATTRIBUTES,
      }

      const created = yield* WorkspaceAdapterRuntime.create(adapter, config, env)
      // Adapter create may already have provisioned remote resources. Any failure
      // after this point must compensate with remove so the user is not left with
      // an unusable workspace. Do not wait on remote SSE readiness here — remotes
      // can lag past TIMEOUT, and ensureReady still gates first use.
      const finalized: Info = created
        ? {
            id: info.id,
            type: info.type,
            branch: created.branch ?? null,
            name: created.name,
            directory: created.directory ?? null,
            extra: jsonExtra(created.extra),
            projectID: info.projectID,
            timeUsed: info.timeUsed,
          }
        : { ...info, extra: jsonExtra(info.extra) }
      return yield* Effect.gen(function* () {
        yield* db
          .insert(WorkspaceTable)
          .values({
            id: finalized.id,
            type: finalized.type,
            branch: finalized.branch,
            name: finalized.name,
            directory: finalized.directory,
            extra: finalized.extra,
            project_id: finalized.projectID,
            time_used: finalized.timeUsed,
          })
          .run()
          .pipe(Effect.orDie)
        settledConnections.delete(finalized.id)
        yield* startSync(finalized)
        // Fail closed before the HTTP encoder so invalid adapter metadata cannot
        // leave a provisioned workspace that clients cannot move to.
        return yield* Schema.decodeUnknownEffect(Info)(finalized).pipe(Effect.orDie)
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.all(
            [
              stopSync(finalized.id),
              db.delete(WorkspaceTable).where(eq(WorkspaceTable.id, finalized.id)).run().pipe(Effect.ignore),
              WorkspaceAdapterRuntime.remove(finalized).pipe(Effect.ignore),
            ],
            { discard: true },
          ).pipe(Effect.andThen(Effect.failCause(cause))),
        ),
      )
    })

    const activate = Effect.fnUntraced(function* (workspaceID: WorkspaceV2.ID) {
      const space = yield* get(workspaceID)
      if (!space)
        return yield* new WorkspaceNotFoundError({
          message: `Workspace not found: ${workspaceID}`,
          workspaceID,
        })

      const adapterStatus = yield* WorkspaceAdapterRuntime.status(space)
      if (adapterStatus === undefined) {
        const target = yield* WorkspaceAdapterRuntime.target(space)
        if (target.type === "local") return
      }
      yield* WorkspaceAdapterRuntime.ensureReady(space)
      yield* stopSync(workspaceID)
      settledConnections.delete(workspaceID)
      yield* startSync(space)
      const remote = WorkspaceAdapterRuntime.kind(space) !== "local"
      // Without experimental workspaces, remote startSync is intentionally a
      // no-op. Do not wait for SSE status that will never settle.
      if (remote && !flags.experimentalWorkspaces) return
      // Settled "error" still means the readiness probe finished. Move uses
      // direct HTTP against target(), so a failed SSE loop must not block the
      // transfer; only a hang/timeout is fatal here.
      yield* waitForConnection(
        workspaceID,
        new Set(["connected", "error"]),
        remote ? REMOTE_READY_TIMEOUT : TIMEOUT,
      )
    })

    const ensureReady = Effect.fn("Workspace.ensureReady")(function* (workspaceID: WorkspaceV2.ID) {
      const ready = yield* SynchronizedRef.modifyEffect(
        readiness,
        Effect.fnUntraced(function* (items) {
          const current = items.get(workspaceID)
          if (current) return [current, items] as const
          const next = yield* Effect.cached(
            activate(workspaceID).pipe(
              Effect.ensuring(
                SynchronizedRef.update(readiness, (state) => {
                  const next = new Map(state)
                  next.delete(workspaceID)
                  return next
                }),
              ),
            ),
          )
          return [next, new Map(items).set(workspaceID, next)] as const
        }),
      )
      return yield* ready
    })

    // Move/proxy need the adapter runtime + target URL. They do not need the
    // experimental SSE event loop to report "connected" first.
    const prepareMove = Effect.fnUntraced(function* (workspaceID: WorkspaceV2.ID) {
      const space = yield* get(workspaceID)
      if (!space)
        return yield* new WorkspaceNotFoundError({
          message: `Workspace not found: ${workspaceID}`,
          workspaceID,
        })
      yield* WorkspaceAdapterRuntime.ensureReady(space)
      if (flags.experimentalWorkspaces || WorkspaceAdapterRuntime.kind(space) === "local") {
        if (!(yield* FiberMap.has(syncFibers, workspaceID))) yield* startSync(space)
      }
      return space
    })

    // A freshly provisioned remote workspace can report ready while its
    // opencode server is still booting; transfers fired into that window fail
    // (a proxy in front returns 5xx). Gate on the health endpoint first.
    const waitForRemoteTarget = Effect.fnUntraced(function* (
      workspaceID: WorkspaceV2.ID,
      target: Extract<Target, { type: "remote" }>,
    ) {
      const deadline = Date.now() + REMOTE_READY_TIMEOUT
      while (true) {
        const status = yield* http
          .execute(
            HttpClientRequest.get(route(target.url, "/global/health"), { headers: new Headers(target.headers) }),
          )
          .pipe(
            Effect.timeout("5 seconds"),
            Effect.flatMap((response) => response.text.pipe(Effect.as(response.status))),
            Effect.catch(() => Effect.succeed(0)),
          )
        if (status >= 200 && status < 300) return
        if (Date.now() >= deadline)
          return yield* new WorkspaceNotReadyError({
            message: `The remote workspace is not answering (${status ? `HTTP ${status}` : "unreachable"}). Check it is running, then retry.`,
            workspaceID,
          })
        yield* Effect.sleep("2 seconds")
      }
    })

    const replayCommittedMoveToSource = Effect.fnUntraced(function* (
      workspaceID: WorkspaceV2.ID | undefined,
      sessionID: SessionID,
      directory: string,
    ) {
      if (!workspaceID) return
      const space = yield* get(workspaceID)
      if (!space) return
      const target = yield* WorkspaceAdapterRuntime.target(space)
      if (target.type === "local") return
      const event = yield* db
        .select({
          id: EventTable.id,
          aggregateID: EventTable.aggregate_id,
          seq: EventTable.seq,
          type: EventTable.type,
          data: EventTable.data,
        })
        .from(EventTable)
        .where(and(eq(EventTable.aggregate_id, sessionID), eq(EventTable.type, "session.next.moved.1")))
        .orderBy(desc(EventTable.seq))
        .get()
        .pipe(Effect.orDie)
      if (!event) return
      const response = yield* http.execute(
        HttpClientRequest.post(route(target.url, "/sync/replay"), {
          headers: new Headers(target.headers),
          body: HttpBody.jsonUnsafe({ directory, events: [event] }),
        }),
      )
      if (response.status >= 200 && response.status < 300) return
      const body = yield* response.text
      return yield* new MoveSessionHttpError({
        message: `Failed to finalize session ${sessionID} at source workspace ${workspaceID}: HTTP ${response.status} ${body}`,
        workspaceID,
        sessionID,
        status: response.status,
        body,
      })
    })

    const moveSession = Effect.fn("Workspace.moveSession")(function* (input: MoveSessionInput) {
      return yield* Effect.gen(function* () {
        const current = yield* db
          .select({ workspaceID: SessionTable.workspace_id, directory: SessionTable.directory })
          .from(SessionTable)
          .where(eq(SessionTable.id, input.sessionID))
          .get()
          .pipe(Effect.orDie)

        if (
          current &&
          current.workspaceID === (input.workspaceID ?? null) &&
          current.directory === input.destinationDirectory
        ) {
          const moved = yield* db
            .select({ data: EventTable.data })
            .from(EventTable)
            .where(and(eq(EventTable.aggregate_id, input.sessionID), eq(EventTable.type, "session.next.moved.1")))
            .orderBy(desc(EventTable.seq))
            .get()
            .pipe(Effect.orDie)
          const metadata = moveMetadata(moved?.data)
          if (!metadata?.source || !metadata.transferHash) return

          yield* replayCommittedMoveToSource(
            metadata.source.workspaceID ? WorkspaceV2.ID.make(metadata.source.workspaceID) : undefined,
            input.sessionID,
            current.directory,
          )

          if (input.workspaceID) {
            const space = yield* get(input.workspaceID)
            if (!space)
              return yield* new WorkspaceNotFoundError({
                message: `Workspace not found: ${input.workspaceID}`,
                workspaceID: input.workspaceID,
              })
            const target = yield* WorkspaceAdapterRuntime.target(space)
            if (target.type === "remote") {
              const rows = yield* db
                .select({
                  id: EventTable.id,
                  aggregateID: EventTable.aggregate_id,
                  seq: EventTable.seq,
                  type: EventTable.type,
                  data: EventTable.data,
                })
                .from(EventTable)
                .where(eq(EventTable.aggregate_id, input.sessionID))
                .orderBy(asc(EventTable.seq))
                .all()
                .pipe(Effect.orDie)
              yield* Effect.forEach(
                Iterable.chunksOf(rows, 10),
                (batch) =>
                  http
                    .execute(
                      HttpClientRequest.post(route(target.url, "/sync/replay"), {
                        headers: new Headers(target.headers),
                        body: HttpBody.jsonUnsafe({ directory: current.directory, events: batch }),
                      }),
                    )
                    .pipe(
                      Effect.flatMap((response) =>
                        response.status >= 200 && response.status < 300
                          ? Effect.void
                          : Effect.fail(
                              new ChangeTransferError({
                                message: "The destination did not finalize the committed move",
                              }),
                            ),
                      ),
                    ),
                { discard: true },
              )
            }
            yield* events.claim(input.sessionID, input.workspaceID)
          }

          const patch = yield* runInWorkspace({
            workspaceID: metadata.source.workspaceID ? WorkspaceV2.ID.make(metadata.source.workspaceID) : undefined,
            directory: metadata.source.directory,
            local: () => vcs.diffRaw(),
            remote: ({ target }) =>
              HttpClientRequest.get(route(target.url, "/vcs/diff/raw"), { headers: new Headers(target.headers) }),
            fallback: "",
            response: "text",
          }).pipe(Effect.provide(AppNodeBuilderV1.build(InstanceStore.node)))
          if (!patch) return
          if (new Bun.CryptoHasher("sha256").update(patch).digest("hex") !== metadata.transferHash) {
            return yield* new ChangeTransferError({
              message: "The session moved, but its source now has different changes and requires manual cleanup.",
            })
          }
          const discarded = yield* runInWorkspace({
            workspaceID: metadata.source.workspaceID ? WorkspaceV2.ID.make(metadata.source.workspaceID) : undefined,
            directory: metadata.source.directory,
            local: () => vcs.discard({ patch }),
            remote: ({ target }) =>
              HttpClientRequest.post(route(target.url, "/vcs/discard"), {
                headers: new Headers(target.headers),
                body: HttpBody.jsonUnsafe({ patch }),
              }),
            fallback: { applied: false },
          }).pipe(Effect.provide(AppNodeBuilderV1.build(InstanceStore.node)))
          if (!discarded.applied)
            return yield* new ChangeTransferError({ message: "The committed move still requires source cleanup" })
          return
        }

        // Once the move commits, the source is abandoned. A remote source may
        // be paused, unreachable, or torn down by its adapter the moment the
        // move lands (e.g. a workspace adapter reclaiming its backend), so
        // post-commit source cleanup against it is best-effort — it must not
        // fail a move whose destination already has the session and changes.
        let sourceRemote = false

        if (current?.workspaceID) {
          const previous = yield* get(current.workspaceID)
          if (previous) {
            yield* prepareMove(previous.id)
            const target = yield* WorkspaceAdapterRuntime.target(previous)
            sourceRemote = target.type === "remote"

            if (target.type === "remote") {
              const response = yield* http.execute(
                HttpClientRequest.post(route(target.url, `/session/${input.sessionID}/abort`), {
                  headers: new Headers(target.headers),
                }),
              )
              if (response.status < 200 || response.status >= 300) {
                const body = yield* response.text
                return yield* new MoveSessionHttpError({
                  message: `Failed to stop session ${input.sessionID} before moving: HTTP ${response.status} ${body}`,
                  workspaceID: previous.id,
                  sessionID: input.sessionID,
                  status: response.status,
                  body,
                })
              }
              yield* syncHistory(previous, target.url, target.headers).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("session move final source sync failed", {
                    workspaceID: previous.id,
                    sessionID: input.sessionID,
                    error: errorData(error),
                  }),
                ),
              )
            } else {
              yield* Effect.gen(function* () {
                const store = yield* InstanceStore.Service
                yield* store.provide({ directory: target.directory }, prompt.cancel(input.sessionID))
              }).pipe(Effect.provide(AppNodeBuilderV1.build(InstanceStore.node)))
            }
          }
        } else if (current?.directory) {
          yield* Effect.gen(function* () {
            const store = yield* InstanceStore.Service
            yield* store.provide({ directory: current.directory }, prompt.cancel(input.sessionID))
          }).pipe(Effect.provide(AppNodeBuilderV1.build(InstanceStore.node)))
        }

        // Resolve the destination before transferring anything. Adapter
        // ensureReady + target URL are enough for move; do not block on
        // experimental SSE connectivity — /sync/replay is plain HTTP.
        const destination = input.workspaceID ? yield* prepareMove(input.workspaceID) : undefined
        const destinationTarget = destination ? yield* WorkspaceAdapterRuntime.target(destination) : undefined
        if (destination && destinationTarget?.type === "remote")
          yield* waitForRemoteTarget(destination.id, destinationTarget)

        const captured = input.copyChanges
          ? yield* runInWorkspace<string | null, never, never>({
              workspaceID: current?.workspaceID ?? undefined,
              directory: current?.directory,
              local: () => vcs.diffRaw(),
              remote: ({ target }) =>
                HttpClientRequest.get(route(target.url, "/vcs/diff/raw"), {
                  headers: new Headers(target.headers),
                }),
              fallback: null,
              response: "text",
            }).pipe(Effect.provide(AppNodeBuilderV1.build(InstanceStore.node)))
          : ""
        if (captured === null) {
          return yield* new ChangeTransferError({
            message:
              "Unable to capture source changes from the remote workspace. Check auth/proxy health, then retry the move with copy changes enabled.",
          })
        }
        if (input.copyChanges && !captured) {
          yield* Effect.logWarning("session move copyChanges requested but source has no dirty patch", {
            sessionID: input.sessionID,
            workspaceID: current?.workspaceID,
          })
        }
        const sourcePatch = captured
        const transferHash = sourcePatch ? new Bun.CryptoHasher("sha256").update(sourcePatch).digest("hex") : undefined
        if (sourcePatch) {
          yield* Effect.logInfo("session move transferring changes", {
            sessionID: input.sessionID,
            bytes: sourcePatch.length,
            fromWorkspaceID: current?.workspaceID,
            toWorkspaceID: input.workspaceID,
          })
        }

        // Transfer changes before the session moves so a rejected transfer
        // never leaves a moved session pointing at a destination without its
        // changes.
        if (sourcePatch) {
          if (destination && destinationTarget?.type === "remote") {
            // A remote destination may carry unrelated working-tree dirt, and a
            // retried move may have already transferred this patch. The
            // destination's /vcs/apply converges on already-applied patches,
            // so send the transfer directly and surface the destination's
            // actual git failure when it rejects.
            const response = yield* remoteMoveRequest(
              HttpClientRequest.post(route(destinationTarget.url, "/vcs/apply"), {
                headers: new Headers(destinationTarget.headers),
                body: HttpBody.jsonUnsafe({ patch: sourcePatch }),
              }),
              { workspaceID: destination.id, sessionID: input.sessionID, step: "transferring changes" },
            ).pipe(
              Effect.catchIf(HttpClientError.isHttpClientError, () =>
                Effect.fail(
                  new ChangeTransferError({
                    message:
                      "Unable to reach the remote workspace to transfer changes. Check the workspace is running, then retry.",
                  }),
                ),
              ),
            )
            if (response.status < 200 || response.status >= 300) {
              const body = yield* response.text.pipe(Effect.catch(() => Effect.succeed("")))
              yield* Effect.logWarning("session move change transfer rejected", {
                workspaceID: destination.id,
                sessionID: input.sessionID,
                status: response.status,
                body: body.slice(0, 500),
              })
              return yield* new ChangeTransferError({
                message: `The destination could not apply source changes: ${remoteFailure(body) ?? `HTTP ${response.status}`}`,
              })
            }
          } else {
            const directory =
              destinationTarget?.type === "local"
                ? (input.destinationDirectory ?? destinationTarget.directory)
                : input.destinationDirectory
            if (!directory) return yield* new ChangeTransferError({ message: "A destination directory is required" })
            const inDestination = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              Effect.gen(function* () {
                const store = yield* InstanceStore.Service
                return yield* store.provide({ directory }, effect)
              }).pipe(Effect.provide(AppNodeBuilderV1.build(InstanceStore.node)))
            // Local destinations must stay clean so transferred changes never
            // mix with unrelated work. Dirt is only acceptable when a prior
            // attempt already applied this exact patch.
            if (yield* inDestination(vcs.diffRaw())) {
              if (!(yield* inDestination(vcs.applied({ patch: sourcePatch }))))
                return yield* new ChangeTransferError({
                  message:
                    "The destination has changes. Commit, stash, or move them before transferring source changes.",
                })
            } else {
              yield* inDestination(vcs.apply({ patch: sourcePatch }))
            }
          }
        }

        const discardSource = () => {
          if (!sourcePatch) return Effect.void
          return runInWorkspace({
            workspaceID: current?.workspaceID ?? undefined,
            directory: current?.directory,
            local: () => vcs.discard({ patch: sourcePatch }),
            remote: ({ target }) =>
              HttpClientRequest.post(route(target.url, "/vcs/discard"), {
                headers: new Headers(target.headers),
                body: HttpBody.jsonUnsafe({ patch: sourcePatch }),
              }),
            fallback: { applied: false },
          }).pipe(
            Effect.provide(AppNodeBuilderV1.build(InstanceStore.node)),
            Effect.flatMap((result) =>
              result.applied
                ? Effect.void
                : // A local source must clear its now-duplicated changes; a remote
                  // source is abandoned and may already be gone, so a failed
                  // discard there is logged, not fatal.
                  sourceRemote
                  ? Effect.logWarning("session move source discard skipped", {
                      sessionID: input.sessionID,
                      workspaceID: current?.workspaceID,
                    })
                  : Effect.fail(new ChangeTransferError({ message: "The source did not clear transferred changes" })),
            ),
          )
        }

        // The source may already be gone once the move commits; notifying it is
        // a courtesy, never a reason to fail an otherwise-complete move.
        const notifySource = (workspaceID: WorkspaceV2.ID | undefined, directory: string) =>
          replayCommittedMoveToSource(workspaceID, input.sessionID, directory).pipe(
            Effect.catch((error) =>
              Effect.logWarning("session move source notify failed", {
                sessionID: input.sessionID,
                workspaceID,
                error: errorData(error),
              }),
            ),
          )

        if (input.workspaceID === null) {
          if (!input.destinationDirectory)
            return yield* new ChangeTransferError({ message: "A destination directory is required" })
          yield* mover.moveSession({
            sessionID: input.sessionID,
            destination: { directory: AbsolutePath.make(input.destinationDirectory) },
            moveChanges: false,
            transferHash,
          })
          yield* notifySource(current?.workspaceID ?? undefined, input.destinationDirectory)
          if (current?.workspaceID) {
            const previous = yield* get(current.workspaceID)
            if (previous) yield* events.claim(input.sessionID, previous.projectID)
          }
          yield* discardSource()

          return
        }

        const workspaceID = input.workspaceID
        const space = destination
        const target = destinationTarget
        if (!space || !target)
          return yield* new WorkspaceNotFoundError({
            message: `Workspace not found: ${workspaceID}`,
            workspaceID,
          })

        if (target.type === "local") {
          yield* mover.moveSession({
            sessionID: input.sessionID,
            destination: {
              directory: AbsolutePath.make(input.destinationDirectory ?? target.directory),
              workspaceID,
            },
            moveChanges: false,
            transferHash,
          })
          yield* notifySource(current?.workspaceID ?? undefined, input.destinationDirectory ?? target.directory)
          yield* events.claim(input.sessionID, workspaceID)
          yield* discardSource()

          return
        }

        yield* Effect.logInfo("session move replaying history", {
          sessionID: input.sessionID,
          workspaceID,
          url: String(target.url),
        })

        const rows = yield* db
          .select({
            id: EventTable.id,
            aggregateID: EventTable.aggregate_id,
            seq: EventTable.seq,
            type: EventTable.type,
            data: EventTable.data,
          })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, input.sessionID))
          .orderBy(asc(EventTable.seq))
          .all()
          .pipe(Effect.orDie)
        const batches = [...Iterable.chunksOf(rows, 10)]

        yield* Effect.forEach(
          batches,
          (events, i) =>
            Effect.gen(function* () {
              yield* Effect.logInfo("session move replay batch", {
                sessionID: input.sessionID,
                workspaceID,
                batch: i + 1,
                batches: batches.length,
                events: events.length,
              })
              const response = yield* remoteMoveRequest(
                HttpClientRequest.post(route(target.url, "/sync/replay"), {
                  headers: new Headers(target.headers),
                  body: HttpBody.jsonUnsafe({
                    directory: space.directory ?? "",
                    events,
                  }),
                }),
                {
                  workspaceID,
                  sessionID: input.sessionID,
                  step: `replay batch ${i + 1}/${batches.length}`,
                },
              )

              if (response.status < 200 || response.status >= 300) {
                const body = yield* response.text
                return yield* new MoveSessionHttpError({
                  message: `Failed to move session ${input.sessionID} into workspace ${workspaceID}: HTTP ${response.status} ${body}`,
                  workspaceID,
                  sessionID: input.sessionID,
                  status: response.status,
                  body,
                })
              }
            }),
          { discard: true },
        )

        const destinationDirectory = input.destinationDirectory ?? space.directory
        if (!destinationDirectory)
          return yield* new ChangeTransferError({ message: "The destination workspace did not provide a directory" })
        yield* Effect.logInfo("session move committing destination", {
          sessionID: input.sessionID,
          workspaceID,
          destinationDirectory,
        })
        yield* mover.moveSession({
          sessionID: input.sessionID,
          destination: { directory: AbsolutePath.make(destinationDirectory), workspaceID },
          moveChanges: false,
          transferHash,
        })
        yield* notifySource(current?.workspaceID ?? undefined, destinationDirectory)

        const committed = yield* db
          .select({
            id: EventTable.id,
            aggregateID: EventTable.aggregate_id,
            seq: EventTable.seq,
            type: EventTable.type,
            data: EventTable.data,
          })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, input.sessionID))
          .orderBy(asc(EventTable.seq))
          .all()
          .pipe(Effect.orDie)
        const moved = committed.slice(rows.length)
        if (moved.length) {
          const response = yield* remoteMoveRequest(
            HttpClientRequest.post(route(target.url, "/sync/replay"), {
              headers: new Headers(target.headers),
              body: HttpBody.jsonUnsafe({ directory: destinationDirectory, events: moved }),
            }),
            {
              workspaceID,
              sessionID: input.sessionID,
              step: "finalize moved event",
            },
          )
          if (response.status < 200 || response.status >= 300) {
            const body = yield* response.text
            return yield* new MoveSessionHttpError({
              message: `Failed to finalize session ${input.sessionID} in workspace ${workspaceID}: HTTP ${response.status} ${body}`,
              workspaceID,
              sessionID: input.sessionID,
              status: response.status,
              body,
            })
          }
        }

        yield* events.claim(input.sessionID, workspaceID)
        yield* discardSource()
        yield* Effect.logInfo("session move complete", { sessionID: input.sessionID, workspaceID })
      })
    })
    const list = Effect.fn("Workspace.list")(function* (project: Project.Info) {
      return (yield* db
        .select()
        .from(WorkspaceTable)
        .where(eq(WorkspaceTable.project_id, project.id))
        .all()
        .pipe(Effect.orDie))
        .map(fromRow)
        .sort((a, b) => a.id.localeCompare(b.id))
    })

    const syncList = Effect.fn("Workspace.syncList")(function* (project: Project.Info) {
      const names = new Set((yield* list(project)).map((workspace) => workspace.name))
      const discovered = yield* Effect.forEach(
        registeredAdapters(project.id),
        ([type, adapter]) =>
          WorkspaceAdapterRuntime.list(adapter).pipe(
            Effect.catchCause((error) =>
              Effect.logWarning("workspace adapter list failed", { type, error }).pipe(Effect.as([])),
            ),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((items) => items.flat()))

      yield* Effect.forEach(
        discovered,
        (item) =>
          Effect.gen(function* () {
            if (names.has(item.name)) return
            names.add(item.name)

            const info: Info = {
              id: WorkspaceV2.ID.ascending(),
              type: item.type,
              branch: item.branch,
              name: item.name,
              directory: item.directory,
              extra: item.extra,
              projectID: item.projectID,
              timeUsed: Date.now(),
            }

            yield* db
              .insert(WorkspaceTable)
              .values({
                id: info.id,
                type: info.type,
                branch: info.branch,
                name: info.name,
                directory: info.directory,
                extra: info.extra,
                project_id: info.projectID,
                time_used: info.timeUsed,
              })
              .run()
              .pipe(Effect.orDie)

            yield* startSync(info)
          }),
        { concurrency: 1 },
      )
    })

    const get = Effect.fn("Workspace.get")(function* (id: WorkspaceV2.ID) {
      const row = yield* db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, id)).get().pipe(Effect.orDie)
      if (!row) return
      return fromRow(row)
    })

    const remove = Effect.fn("Workspace.remove")(function* (id: WorkspaceV2.ID) {
      const row = yield* db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, id)).get().pipe(Effect.orDie)
      if (!row) return
      const info = fromRow(row)

      // Adapter cleanup is best-effort with a bound: a dead or unreachable
      // backing resource must not make the record undeletable. If the
      // resource still exists remotely, adapter discovery re-registers it on
      // the next list sync.
      yield* WorkspaceAdapterRuntime.remove(info).pipe(
        Effect.timeout(REMOTE_MOVE_HTTP_TIMEOUT),
        Effect.catchCause((cause) =>
          Effect.logWarning("workspace adapter remove failed", { workspaceID: id, cause }),
        ),
      )
      yield* stopSync(id)

      const sessions = yield* db
        .select({ id: SessionTable.id, parentID: SessionTable.parent_id })
        .from(SessionTable)
        .where(eq(SessionTable.workspace_id, id))
        .all()
        .pipe(Effect.orDie)
      const sessionIDs = new Set(sessions.map((sessionInfo) => sessionInfo.id))
      yield* Effect.forEach(
        sessions.filter((sessionInfo) => !sessionInfo.parentID || !sessionIDs.has(sessionInfo.parentID)),
        (sessionInfo) =>
          session.remove(sessionInfo.id).pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.void)),
        { discard: true },
      )

      yield* db.delete(WorkspaceTable).where(eq(WorkspaceTable.id, id)).run().pipe(Effect.orDie)
      return info
    })

    const status = Effect.fn("Workspace.status")(function* () {
      return [...connections.values()]
    })

    const isSyncing = Effect.fn("Workspace.isSyncing")(function* (workspaceID: WorkspaceV2.ID) {
      const exists = yield* FiberMap.has(syncFibers, workspaceID)
      return exists && connections.get(workspaceID)?.status !== "error"
    })

    const waitForSync = Effect.fn("Workspace.waitForSync")(function* (
      workspaceID: WorkspaceV2.ID,
      state: Record<string, number>,
      signal?: AbortSignal,
      timeout = TIMEOUT,
    ) {
      if (yield* synced(db, state)) return

      yield* Effect.catch(
        waitUntilSynced({ db, workspaceID, state, signal, timeout }),
        (): Effect.Effect<never, WaitForSyncError> =>
          signal?.aborted
            ? Effect.fail(
                new SyncAbortedError({
                  message: signal.reason instanceof Error ? signal.reason.message : "Request aborted",
                  cause: signal.reason,
                }),
              )
            : Effect.fail(
                new SyncTimeoutError({
                  message: `Timed out waiting for sync fence: ${JSON.stringify(state)}`,
                  state,
                }),
              ),
      )
    })

    const startWorkspaceSyncing = Effect.fn("Workspace.startWorkspaceSyncing")(function* (projectID: ProjectV2.ID) {
      const rows = yield* db
        .selectDistinct({ workspace: WorkspaceTable })
        .from(WorkspaceTable)
        .where(eq(WorkspaceTable.project_id, projectID))
        .all()
        .pipe(Effect.orDie)

      for (const { workspace } of rows) {
        yield* startSync(fromRow(workspace)).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              setStatus(workspace.id, "error")
            }),
          ),
          Effect.forkDetach,
        )
      }
    })

    return Service.of({
      create,
      moveSession,
      list,
      syncList,
      get,
      remove,
      status,
      ensureReady,
      isSyncing,
      waitForSync,
      startWorkspaceSyncing,
    })
  }),
)

const TIMEOUT = 5000
// Remote agent servers can take well beyond the local worktree path to expose
// /global/event after provision; move/proxy must wait longer than create.
const REMOTE_READY_TIMEOUT = 60_000
// Bound remote move HTTP so a hung /sync/replay cannot leave the TUI spinner forever.
const REMOTE_MOVE_HTTP_TIMEOUT = "30 seconds"

type HistoryEvent = {
  id: string
  aggregate_id: string
  seq: number
  type: string
  data: Record<string, unknown>
}

function waitUntilSynced(input: {
  db: Database.Interface["db"]
  workspaceID: WorkspaceV2.ID
  state: Record<string, number>
  signal?: AbortSignal
  timeout: number
}): Effect.Effect<void, unknown> {
  return Effect.suspend(() =>
    waitEvent({
      timeout: input.timeout,
      signal: input.signal,
      fn(event) {
        return event.workspace === input.workspaceID || event.payload.type === "sync"
      },
    }).pipe(
      Effect.andThen(synced(input.db, input.state)),
      Effect.flatMap((done): Effect.Effect<void, unknown> => (done ? Effect.void : waitUntilSynced(input))),
    ),
  )
}

function synced(db: Database.Interface["db"], state: Record<string, number>): Effect.Effect<boolean> {
  const ids = Object.keys(state)
  if (ids.length === 0) return Effect.succeed(true)

  return db
    .select({
      id: EventSequenceTable.aggregate_id,
      seq: EventSequenceTable.seq,
    })
    .from(EventSequenceTable)
    .where(inArray(EventSequenceTable.aggregate_id, ids))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => {
        const done = Object.fromEntries(rows.map((row) => [row.id, row.seq])) as Record<string, number>
        return ids.every((id) => (done[id] ?? -1) >= state[id])
      }),
    )
}

function route(url: string | URL, path: string) {
  const next = new URL(url)
  next.pathname = `${next.pathname.replace(/\/$/, "")}${path}`
  next.search = ""
  next.hash = ""
  return next
}

function jsonExtra(value: unknown): Schema.MutableJson | null {
  if (value == null) return null
  try {
    return JSON.parse(JSON.stringify(value)) as Schema.MutableJson
  } catch {
    return null
  }
}

function remoteFailure(body: string) {
  const trimmed = body.trim()
  // Proxies answer with HTML error pages; those carry no usable detail for
  // the user, so fall back to the HTTP status instead.
  if (!trimmed || /^<(?:!doctype|html)/i.test(trimmed)) return undefined
  try {
    const parsed = JSON.parse(trimmed) as { data?: { message?: unknown }; message?: unknown }
    const message = parsed.data?.message ?? parsed.message
    if (typeof message === "string" && message) return message
  } catch {
    // fall through to the raw body
  }
  return trimmed.slice(0, 300)
}

function moveMetadata(data: unknown) {
  if (typeof data !== "object" || data === null) return
  const value = data as Record<string, unknown>
  const source = value.source
  if (typeof source !== "object" || source === null) return
  const location = source as Record<string, unknown>
  if (typeof location.directory !== "string") return
  return {
    source: {
      directory: location.directory,
      workspaceID: typeof location.workspaceID === "string" ? location.workspaceID : undefined,
    },
    transferHash: typeof value.transferHash === "string" ? value.transferHash : undefined,
  }
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Auth.node,
    Session.node,
    SessionPrompt.node,
    MoveSession.node,
    httpClient,
    EventV2Bridge.node,
    Vcs.node,
    RuntimeFlags.node,
    FSUtil.node,
    Database.node,
  ],
})

export * as Workspace from "./workspace"
