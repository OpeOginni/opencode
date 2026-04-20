/** @jsxImportSource @opentui/solid */
import type { AssistantMessage, Part, ReasoningPart, TextPart } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal } from "solid-js"

const id = "local.message-tps"
const visibilityKey = "plugin.message_tps.visible"
const hiddenFinishes = new Set(["tool-calls", "unknown"])
const hiddenReasoning = new Set(["[REDACTED]", ""])

type StreamingPart = (TextPart | ReasoningPart) & {
  time: {
    start: number
    end: number
  }
}

function isVisible(value: unknown) {
  if (typeof value === "boolean") return value
  return true
}

function isStreamingPart(part: Part): part is StreamingPart {
  if (part.type !== "text" && part.type !== "reasoning") return false
  if (!part.time?.start || !part.time.end) return false
  if (part.type === "text") return part.text.trim().length > 0
  return !hiddenReasoning.has(part.text.trim())
}

function formatRate(value: number) {
  if (!Number.isFinite(value) || value <= 0) return
  if (value >= 100) return value.toFixed(0)
  if (value >= 10) return value.toFixed(1)
  return value.toFixed(2)
}

function finalMessage(message: AssistantMessage | undefined) {
  if (!message?.finish) return false
  if (hiddenFinishes.has(message.finish)) return false
  return !!message.time.completed
}

function View(props: {
  api: Parameters<TuiPlugin>[0]
  visible: () => boolean
  sessionID: string
  messageID: string
}) {
  const theme = () => props.api.theme.current
  const message = createMemo(() => {
    const item = props.api.state.session.messages(props.sessionID).find((entry) => entry.id === props.messageID)
    if (!item || item.role !== "assistant") return
    return item
  })
  const rate = createMemo(() => {
    if (!props.visible()) return
    if (!finalMessage(message())) return

    const parts = props.api.state.part(props.messageID).filter(isStreamingPart)
    if (parts.length === 0) return

    const totalStreamingMs = parts.reduce((sum, part) => sum + (part.time.end - part.time.start), 0)
    if (totalStreamingMs <= 0) return

    const reasoning = parts.some((part) => part.type === "reasoning") ? message()!.tokens.reasoning : 0
    return formatRate((message()!.tokens.output + reasoning) / (totalStreamingMs / 1000))
  })

  return (
    <>{rate() ? (
      <text fg={theme().textMuted}>· {rate()} tps</text>
    ) : null}</>
  )
}

const tui: TuiPlugin = async (api) => {
  const [visible, setVisible] = createSignal(isVisible(api.kv.get(visibilityKey, true)))

  api.command.register(() => [
    {
      title: visible() ? "Hide message TPS" : "Show message TPS",
      value: "plugin.message-tps.toggle",
      category: "Plugin",
      slash: {
        name: "message-tps",
        aliases: ["tps"],
      },
      onSelect: () => {
        const next = !visible()
        api.kv.set(visibilityKey, next)
        setVisible(next)
      },
    },
  ])

  api.slots.register<{ session_assistant_footer: { session_id: string; message_id: string } }>({
    slots: {
      session_assistant_footer(_ctx, value) {
        return <View api={api} visible={visible} sessionID={value.session_id} messageID={value.message_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
