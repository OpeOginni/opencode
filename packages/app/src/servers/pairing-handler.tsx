import { onCleanup, onMount } from "solid-js"
import { OpenCode } from "@opencode-ai/client/promise"
import { useGlobal } from "@/runtime/server/runtime"
import { useLanguage } from "@/runtime/i18n/language"
import { useCheckServerHealth } from "@/runtime/server/health"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useTabs } from "@/shell/tabs/tabs"
import { showToast } from "@/shell/notifications/toast"
import { useDirectoryPicker } from "@/workspaces/selection/picker"
import { isPairingLink, parsePairingIntent, type PairingIntent } from "./pairing"

const deepLinkEvent = "opencode:deep-link"

type DeepLinkWindow = Window & { __OPENCODE__?: { deepLinks?: string[] } }

export function PairingHandler(props: { intent?: PairingIntent }) {
  const servers = useServers()
  const global = useGlobal()
  const tabs = useTabs()
  const language = useLanguage()
  const checkServerHealth = useCheckServerHealth()
  const pickDirectory = useDirectoryPicker()
  let generation = 0
  onCleanup(() => generation++)

  const connect = (intent: PairingIntent) => {
    const attempt = ++generation
    const failed = () => {
      if (attempt === generation) {
        showToast({ variant: "error", title: language.t("dialog.server.add.error") })
      }
    }
    void OpenCode.make({ baseUrl: intent.server })
      .server.pairing.redeem({ ticket: intent.ticket })
      .then(async (credentials) => {
        if (attempt !== generation) return
        const existing = servers.list.find(
          (item): item is ServerConnection.Http =>
            item.type === "http" && ServerConnection.key(item) === ServerConnection.Key.make(intent.server),
        )
        const connection: ServerConnection.Http = {
          type: "http",
          displayName: existing?.displayName,
          label: existing?.label,
          http: { url: intent.server, password: credentials.password },
        }
        if (!(await checkServerHealth(connection.http)).healthy || attempt !== generation) return failed()

        const paired = servers.add(connection)
        const directory = intent.directory
        if (!paired || !directory) return
        const ctx = global.ensureServerCtx(paired)
        const open = (directory: string) => {
          if (attempt !== generation) return
          ctx.projects.open(directory)
          ctx.projects.touch(directory)
          void tabs.newDraft({ server: ServerConnection.key(paired), directory })
        }
        void ctx.sdk.api.file
          .list({ path: ".", location: { directory } })
          .then(() => open(directory))
          .catch(() => {
            if (attempt !== generation) return
            pickDirectory({
              server: paired,
              start: directory,
              title: language.t("command.project.open"),
              onSelect: (result) => {
                if (attempt !== generation) return
                const directory = Array.isArray(result) ? result[0] : result
                if (directory) open(directory)
              },
            })
          })
      })
      .catch(failed)
  }

  const consume = () => {
    const target = window as DeepLinkWindow
    const pending = target.__OPENCODE__?.deepLinks ?? []
    const intents = pending.map(parsePairingIntent)
    if (target.__OPENCODE__) target.__OPENCODE__.deepLinks = pending.filter((input) => !isPairingLink(input))
    const intent = intents.filter((value): value is PairingIntent => !!value).at(-1)
    if (intent) connect(intent)
  }

  onMount(() => {
    if (props.intent) connect(props.intent)
    consume()
    window.addEventListener(deepLinkEvent, consume)
  })
  onCleanup(() => window.removeEventListener(deepLinkEvent, consume))

  return null
}
