export * as SessionImport from "./import"

import { Database } from "@opencode-ai/core/database/database"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { InstanceContext } from "@/project/instance-context"
import path from "path"
import { Effect, Schema } from "effect"
import { Session } from "./session"

export const Data = Schema.Struct({
  info: Session.Info,
  messages: Schema.Array(SessionV1.WithParts),
})
export type Data = typeof Data.Type

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("SessionImportInvalidError", {
  message: Schema.String,
}) {}

export const run = Effect.fn("SessionImport.run")(function* (input: { data: Data; context: InstanceContext }) {
  const invalid = input.data.messages.find(
    (message) =>
      message.info.sessionID !== input.data.info.id ||
      message.parts.some((part) => part.sessionID !== input.data.info.id || part.messageID !== message.info.id),
  )
  if (invalid) return yield* new InvalidError({ message: "Session transcript contains mismatched IDs" })

  const { db } = yield* Database.Service
  const events = yield* EventV2Bridge.Service
  const info = {
    ...input.data.info,
    projectID: input.context.project.id,
    directory: input.context.directory,
    path: path.relative(path.resolve(input.context.worktree), input.context.directory).replaceAll("\\", "/"),
    time: { ...input.data.info.time, updated: Date.now() },
  }
  const row = Session.toRow(info)

  yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        yield* tx
          .insert(SessionTable)
          .values(row)
          .onConflictDoUpdate({
            target: SessionTable.id,
            set: {
              project_id: row.project_id,
              directory: row.directory,
              path: row.path,
              time_updated: row.time_updated,
            },
          })
          .run()

        for (const message of input.data.messages) {
          const messageInfo = message.info
          const { id, sessionID: _, ...data } = messageInfo
          yield* tx
            .insert(MessageTable)
            .values({
              id,
              session_id: row.id,
              time_created: messageInfo.time?.created ?? Date.now(),
              data: data as never,
            })
            .onConflictDoNothing()
            .run()

          for (const part of message.parts) {
            const { id: partID, sessionID: _sessionID, messageID, ...partData } = part
            yield* tx
              .insert(PartTable)
              .values({
                id: partID,
                message_id: messageID,
                session_id: row.id,
                data: partData,
              })
              .onConflictDoNothing()
              .run()
          }
        }
      }),
    )
    .pipe(Effect.orDie)

  yield* events.publish(SessionV1.Event.Updated, { sessionID: info.id, info })
  return info
})
