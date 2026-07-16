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
  kind: "remote",
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
    // Instance-scoped requests (e.g. /vcs/apply) carry no directory, so the
    // remote server would fall back to its own cwd. Pin the configured
    // directory so transfers land in the right checkout.
    const directory = config.directory ?? config.extra.directory
    return {
      type: "remote",
      url: config.extra.url,
      headers: directory ? { ...config.extra.headers, "x-opencode-directory": directory } : config.extra.headers,
    }
  },
}
