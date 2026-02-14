import { createOpencodeClient, type AssistantMessage, type Event, type Part } from "@opencode-ai/sdk/v2"
import z from "zod"
import { Session } from "./index"
import { SessionStatus } from "./status"
import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { SessionPrompt } from "./prompt"
import { Flag } from "@/flag/flag"
import { Bus } from "@/bus"
import { NamedError } from "@opencode-ai/util/error"
import { Storage } from "@/storage/storage"
import { Snapshot } from "@/snapshot"
import { LSP } from "@/lsp"
import { File } from "@/file"
import { SessionCompaction } from "@/session/compaction"
import { Todo } from "@/session/todo"
import { MCP } from "@/mcp"
import { Command } from "@/command"
import { Instance } from "@/project/instance"
import { CloudPatch } from "@/session/cloud-patch"
import { CloudStore } from "@/session/cloud-store"

export namespace CloudSession {
  const log = Log.create({ service: "cloud-session" })

  export const PromptInput = SessionPrompt.PromptInput.omit({ sessionID: true }).extend({
    remoteRepoOwner: z.string(),
    remoteRepoName: z.string(),
    remoteBranch: z.string(),
    baseCommitSha: z.string(),
    cloudActive: z.boolean().optional(),
  })

  export type PromptInput = z.infer<typeof PromptInput>

  type PromptError = NonNullable<MessageV2.Assistant["error"]>
  type PromptResult =
    | {
        info: AssistantMessage
        parts: Part[]
      }
    | {
        error: PromptError
      }

  type CloudResult =
    | {
        serverUrl: string
        remoteSessionID: string
        cloudSessionID?: string
      }
    | {
        error: string
      }

  export async function prompt(input: PromptInput & { sessionID: string }): Promise<PromptResult> {
    const session = await Session.get(input.sessionID)
    SessionStatus.set(input.sessionID, { type: "busy" })

    const cloud = await createCloudSession(input, session)
    if ("error" in cloud) {
      const error = new NamedError.Unknown({ message: cloud.error }).toObject() as PromptError
      Bus.publish(Session.Event.Error, { sessionID: input.sessionID, error })
      SessionStatus.set(input.sessionID, { type: "idle" })
      return { error }
    }

    await CloudStore.mark(session.id)

    const client = createOpencodeClient({ baseUrl: cloud.serverUrl })
    const controller = new AbortController()

    let resolveDone = () => {}
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })

    const stream = streamEvents({
      client,
      sessionID: input.sessionID,
      remoteSessionID: cloud.remoteSessionID,
      signal: controller.signal,
      done: resolveDone,
    })

    const { sessionID, ...promptInput } = input

    const result = await (async () => {
      try {
        return await client.session
          .prompt(
            {
              ...promptInput,
              sessionID: cloud.remoteSessionID,
            },
            { throwOnError: true },
          )
          .then((res) => res.data!)
      } finally {
        resolveDone()
        controller.abort()
        await stream.catch((error) => {
          log.error("event stream error", { error: error instanceof Error ? error.message : String(error) })
        })
        SessionStatus.set(sessionID, { type: "idle" })
      }
    })()

    await sync({ client, sessionID, remoteSessionID: cloud.remoteSessionID })
    await destroyCloudSession(session)

    return {
      info: {
        ...result.info,
        sessionID,
      },
      parts: result.parts.map((part) => ({
        ...part,
        sessionID,
      })),
    }
  }

  async function createCloudSession(
    input: PromptInput & { sessionID: string },
    session: Session.Info,
  ): Promise<CloudResult> {
    const cloudApi = Flag.OPENCODE_CLOUD_API
    if (!cloudApi) return { error: "OPENCODE_CLOUD_API is not set" }
    const cloudToken = Flag.OPENCODE_CLOUD_TOKEN
    if (!cloudToken) return { error: "OPENCODE_CLOUD_TOKEN is not set" }

    const providerId = input.model?.providerID
    if (!providerId) return { error: "Model provider is required for cloud sessions" }

    const existingSessionExport = await (async () => {
      if (!input.cloudActive) return undefined
      const messages = await Session.messages({ sessionID: session.id })
      if (messages.length === 0) return undefined
      return {
        info: session,
        messages: messages.map((msg) => ({
          info: msg.info,
          parts: msg.parts,
        })),
      }
    })()

    log.info("existingSessionExport", { existingSessionExport: existingSessionExport })

    const body = input.cloudActive
      ? {
          opencodeSessionId: session.id,
          ...(existingSessionExport ? { existingSessionExport } : {}),
        }
      : {
          localSessionId: session.id,
          remoteRepoOwner: input.remoteRepoOwner,
          remoteRepoName: input.remoteRepoName,
          remoteBranch: input.remoteBranch,
          baseCommitSha: input.baseCommitSha,
          providerId,
        }
    log.info("body", { body: body })

    const cloudUrl = input.cloudActive
      ? `${cloudApi}/trpc/cloudSessions.spawn`
      : `${cloudApi}/trpc/cloudSessions.create`
    const cloudResponse = await fetch(cloudUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cloudToken}`,
      },
      body: JSON.stringify(body),
    })

    const cloudJson = (await cloudResponse.json().catch(() => undefined)) as
      | {
          result?: {
            data?: { serverUrl?: string; sessionId?: string; cloudSessionId?: string }
            error?: string
            message?: string
          }
          error?: string
          message?: string
        }
      | undefined

    const cloudResult = cloudJson?.result
    const cloudData = cloudResult?.data
    const serverUrl = cloudData?.serverUrl
    const remoteSessionID = cloudData?.sessionId
    const cloudSessionID = cloudData?.cloudSessionId
    const cloudError = cloudResult?.error ?? cloudResult?.message ?? cloudJson?.error ?? cloudJson?.message

    log.info("Data", {
      status: cloudResponse.status,
      ok: cloudResponse.ok,
      serverUrl,
      error: cloudError,
    })

    if (!cloudResponse.ok || !serverUrl || !remoteSessionID) {
      const message = cloudError ? `Failed to create cloud sandbox: ${cloudError}` : "Failed to create cloud sandbox"
      log.info("Error", { error: message })
      return { error: message }
    }

    return { serverUrl, remoteSessionID, cloudSessionID }
  }

  async function destroyCloudSession(session: Session.Info) {
    const cloudApi = Flag.OPENCODE_CLOUD_API
    if (!cloudApi) return
    const cloudToken = Flag.OPENCODE_CLOUD_TOKEN
    if (!cloudToken) return

    const body = {
      opencodeSessionId: session.id,
    }

    const response = await fetch(`${cloudApi}/trpc/cloudSessions.destroyCLI`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cloudToken}`,
      },
      body: JSON.stringify(body),
    }).catch((error) => {
      log.error("cloud destroy request failed", { error })
      return undefined
    })

    if (!response?.ok) {
      log.error("cloud destroy failed", { status: response?.status })
      return
    }

    const json = (await response.json().catch(() => undefined)) as
      | {
          result?: {
            data: {
              success: boolean
              patches?: {
                apply?: string | null
                revert?: string | null
              }
            }
          }
        }
      | undefined

    log.info("response_json", { json })

    const apply = json?.result?.data.patches?.apply ?? undefined
    const revert = json?.result?.data.patches?.revert ?? undefined

    log.info("patches_apply", { apply })
    log.info("patches_revert", { revert })
    if (apply === undefined && revert === undefined) return

    await CloudPatch.write({
      sessionID: session.id,
      patch: apply ?? revert ?? undefined,
    })
  }

  async function streamEvents(input: {
    client: ReturnType<typeof createOpencodeClient>
    sessionID: string
    remoteSessionID: string
    signal: AbortSignal
    done: () => void
  }) {
    const events = await input.client.event.subscribe({}, { signal: input.signal }).catch(() => undefined)
    if (!events) return

    for await (const event of events.stream) {
      await applyEvent(event as Event, input)
    }
  }

  async function applyEvent(
    event: Event,
    input: {
      sessionID: string
      remoteSessionID: string
      done: () => void
    },
  ) {
    if (event.type === "session.updated") {
      const info = Session.Info.parse(event.properties.info)
      if (info.id !== input.remoteSessionID) return
      if (!info.summary) return
      await Session.setSummary({
        sessionID: input.sessionID,
        summary: info.summary,
      })
      return
    }

    if (event.type === "session.diff") {
      const { sessionID, diff } = event.properties as { sessionID: string; diff: Snapshot.FileDiff[] }
      if (sessionID !== input.remoteSessionID) return
      const next = Snapshot.FileDiff.array().parse(diff)
      await Storage.write(["session_diff", input.sessionID], next).catch(() => {})
      Bus.publish(Session.Event.Diff, {
        sessionID: input.sessionID,
        diff: next,
      })
      await Session.setSummary({
        sessionID: input.sessionID,
        summary: next.reduce(
          (sum, item) => ({
            additions: sum.additions + item.additions,
            deletions: sum.deletions + item.deletions,
            files: sum.files + 1,
          }),
          { additions: 0, deletions: 0, files: 0 },
        ),
      })
      return
    }

    if (event.type === "lsp.updated") {
      Bus.publish(LSP.Event.Updated, {})
      return
    }

    if (event.type === "file.edited") {
      const file = (event.properties as { file: string }).file
      if (!Instance.containsPath(file)) return
      Bus.publish(File.Event.Edited, { file })
      return
    }

    if (event.type === "session.compacted") {
      const props = event.properties as { sessionID: string }
      if (props.sessionID !== input.remoteSessionID) return
      Bus.publish(SessionCompaction.Event.Compacted, { sessionID: input.sessionID })
      return
    }

    if (event.type === "todo.updated") {
      const props = event.properties as { sessionID: string; todos: Todo.Info[] }
      if (props.sessionID !== input.remoteSessionID) return
      const todos = Todo.Info.array().parse(props.todos)
      Todo.update({ sessionID: input.sessionID, todos })
      return
    }

    if (event.type === "mcp.tools.changed") {
      const props = event.properties as { server: string }
      Bus.publish(MCP.ToolsChanged, props)
      return
    }

    if (event.type === "command.executed") {
      const props = event.properties as { name: string; sessionID: string; arguments: string; messageID: string }
      if (props.sessionID !== input.remoteSessionID) return
      Bus.publish(Command.Event.Executed, {
        name: props.name,
        sessionID: input.sessionID,
        arguments: props.arguments,
        messageID: props.messageID,
      })
      return
    }

    if (event.type === "message.updated") {
      const info = MessageV2.Info.parse(event.properties.info)
      if (info.sessionID !== input.remoteSessionID) return
      await Session.updateMessage({
        ...info,
        sessionID: input.sessionID,
      })
      return
    }

    if (event.type === "message.part.updated") {
      const part = MessageV2.Part.parse(event.properties.part)
      if (part.sessionID !== input.remoteSessionID) return
      await Session.updatePart({
        ...part,
        sessionID: input.sessionID,
      })
      return
    }

    if (event.type === "message.part.delta") {
      const props = event.properties as {
        sessionID: string
        messageID: string
        partID: string
        field: string
        delta: string
      }
      if (props.sessionID !== input.remoteSessionID) return
      await Session.updatePartDelta({
        sessionID: input.sessionID,
        messageID: props.messageID,
        partID: props.partID,
        field: props.field,
        delta: props.delta,
      })
      return
    }

    if (event.type === "message.removed") {
      const props = event.properties as { sessionID: string; messageID: string }
      if (props.sessionID !== input.remoteSessionID) return
      await Session.removeMessage({
        sessionID: input.sessionID,
        messageID: props.messageID,
      })
      return
    }

    if (event.type === "message.part.removed") {
      const props = event.properties as { sessionID: string; messageID: string; partID: string }
      if (props.sessionID !== input.remoteSessionID) return
      await Session.removePart({
        sessionID: input.sessionID,
        messageID: props.messageID,
        partID: props.partID,
      })
      return
    }

    if (event.type === "session.status") {
      const props = event.properties as { sessionID: string; status: SessionStatus.Info }
      if (props.sessionID !== input.remoteSessionID) return
      SessionStatus.set(input.sessionID, props.status)
      if (props.status.type === "idle") input.done()
      return
    }
  }

  async function sync(input: {
    client: ReturnType<typeof createOpencodeClient>
    sessionID: string
    remoteSessionID: string
  }) {
    const messages = await input.client.session
      .messages({ sessionID: input.remoteSessionID })
      .then((res) => res.data)
      .catch(() => undefined)
    if (!messages) return

    for (const msg of messages) {
      const info = MessageV2.Info.parse(msg.info)
      await Session.updateMessage({
        ...info,
        sessionID: input.sessionID,
      })
      for (const part of msg.parts) {
        const parsed = MessageV2.Part.parse(part)
        await Session.updatePart({
          ...parsed,
          sessionID: input.sessionID,
        })
      }
    }
  }
}
