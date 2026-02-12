import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2"
import z from "zod"
import { Session } from "./index"
import { SessionStatus } from "./status"
import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { Identifier } from "@/id/id"
import { SessionPrompt } from "./prompt"

export namespace CloudSession {
  const log = Log.create({ service: "cloud-session" })

  export const PromptInput = SessionPrompt.PromptInput.omit({ sessionID: true }).extend({
    serverUrl: z.url(),
    remoteSessionID: Identifier.schema("session"),
  })

  export type PromptInput = z.infer<typeof PromptInput>

  export async function prompt(input: PromptInput & { sessionID: string }) {
    await Session.get(input.sessionID)
    SessionStatus.set(input.sessionID, { type: "busy" })

    const client = createOpencodeClient({ baseUrl: input.serverUrl })
    const controller = new AbortController()

    let resolveDone = () => {}
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })

    const stream = streamEvents({
      client,
      sessionID: input.sessionID,
      remoteSessionID: input.remoteSessionID,
      signal: controller.signal,
      done: resolveDone,
    })

    const { serverUrl: _, remoteSessionID, sessionID, ...promptInput } = input

    const result = await (async () => {
      try {
        return await client.session
          .prompt(
            {
              ...promptInput,
              sessionID: remoteSessionID,
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

    await sync({ client, sessionID, remoteSessionID })

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
      const delta = event.properties.delta
      if (delta && part.type === "text") {
        await Session.updatePart({
          part: {
            ...part,
            sessionID: input.sessionID,
          },
          delta,
        })
        return
      }
      if (delta && part.type === "reasoning") {
        await Session.updatePart({
          part: {
            ...part,
            sessionID: input.sessionID,
          },
          delta,
        })
        return
      }
      await Session.updatePart({
        ...part,
        sessionID: input.sessionID,
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
