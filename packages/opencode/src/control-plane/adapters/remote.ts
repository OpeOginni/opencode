import { Schema } from "effect"
import { type WorkspaceAdapter, WorkspaceInfo } from "../types"

const RemoteExtra = Schema.Struct({
  url: Schema.String,
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  directory: Schema.optional(Schema.String),
}).annotate({ identifier: "Workspace.RemoteExtra" })

const RemoteConfig = Schema.Struct({
  name: WorkspaceInfo.fields.name,
  branch: WorkspaceInfo.fields.branch,
  directory: WorkspaceInfo.fields.directory,
  extra: RemoteExtra,
}).annotate({ identifier: "Workspace.RemoteConfig" })

const decodeRemoteConfig = Schema.decodeUnknownSync(RemoteConfig)

export const RemoteAdapter: WorkspaceAdapter = {
  name: "Remote",
  description: "Connect to an existing remote opencode server",
  configure(info) {
    const extra = Schema.decodeUnknownSync(RemoteExtra)(info.extra)
    return {
      ...info,
      directory: info.directory ?? extra.directory ?? null,
      extra,
    }
  },
  async create() {},
  async remove() {},
  target(info) {
    const config = decodeRemoteConfig(info)
    return {
      type: "remote",
      url: config.extra.url,
      headers: config.extra.headers,
    }
  },
}
