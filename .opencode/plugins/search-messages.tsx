/** @jsxImportSource @opentui/solid */
import { useTerminalDimensions, type JSX } from "@opentui/solid"
import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiRouteCurrent, TuiThemeCurrent } from "@opencode-ai/plugin/tui"

// IMPORTANT: external TUI plugins must not import `solid-js` directly. The TUI renders with its
// own bundled Solid instance, and a second copy from the plugin's node_modules silently breaks
// reactivity (createMemo/createSignal read back undefined). So this plugin keeps all state in the
// route params (the renderer-owned reactive source) and renders with plain `.map()` / ternaries,
// the same pattern the built-in tui-smoke plugin uses.

const ROUTE = "search-messages"

const cmd = {
  open: "search_open",
  next: "search_next",
  prev: "search_prev",
  close: "search_close",
}

// Navigation keys must be non-text chords so typed characters still flow into the focused input.
const defaultKeymap: Record<string, string> = {
  [cmd.open]: "ctrl+f",
  [cmd.next]: "down,enter,ctrl+n",
  [cmd.prev]: "up,ctrl+p",
  [cmd.close]: "escape",
}

// The scrollbox renderable is published here so the globally-registered nav keybinds can scroll
// the live view to the active match.
let scrollRef: ScrollBoxRenderable | undefined

type Line = {
  role: "user" | "assistant"
  text: string
  first: boolean
}

type Match = {
  line: number
  start: number
}

// The installed @opencode-ai/plugin types (api.command shim) capture `enabled` once, which can't
// express route-scoped keybinds. The HEAD runtime exposes `api.keymap` with a reactive `enabled`,
// so reach it through a narrow typed accessor instead of the not-yet-published type.
type KeymapApi = {
  registerLayer: (layer: {
    commands: Array<{
      name: string
      title?: string
      category?: string
      namespace?: string
      slashName?: string
      enabled?: () => boolean
      run: () => void
    }>
    bindings: Array<{ key: string; cmd: string }>
  }) => unknown
}

function keymapOf(api: TuiPluginApi): KeymapApi {
  return (api as unknown as { keymap: KeymapApi }).keymap
}

type SearchState = {
  sessionID: string
  returnRoute: TuiRouteCurrent | undefined
  query: string
  active: number
}

function readState(api: TuiPluginApi): SearchState {
  const route = api.route.current
  const params = (("params" in route ? route.params : undefined) ?? {}) as Record<string, unknown>
  return {
    sessionID: typeof params.sessionID === "string" ? params.sessionID : "",
    returnRoute: params.returnRoute as TuiRouteCurrent | undefined,
    query: typeof params.query === "string" ? params.query : "",
    active: typeof params.active === "number" ? params.active : 0,
  }
}

function buildLines(api: TuiPluginApi, sessionID: string): Line[] {
  if (!sessionID) return []
  const messages = api.state.session.messages(sessionID) ?? []
  const out: Line[] = []
  for (const message of messages) {
    const text = (api.state.part(message.id) ?? [])
      .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
      .join("\n\n")
      .replace(/\t/g, "  ")
    if (!text.trim()) continue
    text.split("\n").forEach((raw, index) => {
      out.push({ role: message.role, text: raw, first: index === 0 })
    })
  }
  return out
}

function findMatches(lines: Line[], query: string): Match[] {
  const needle = query.toLowerCase()
  if (!needle) return []
  const out: Match[] = []
  lines.forEach((line, index) => {
    const haystack = line.text.toLowerCase()
    let from = 0
    while (true) {
      const at = haystack.indexOf(needle, from)
      if (at === -1) break
      out.push({ line: index, start: at })
      from = at + needle.length
    }
  })
  return out
}

function scrollToLine(lineIndex: number) {
  setTimeout(() => {
    if (!scrollRef || scrollRef.isDestroyed) return
    const child = scrollRef.getChildren().find((c) => c.id === "line-" + lineIndex)
    if (!child) return
    scrollRef.scrollBy(child.y - scrollRef.y - Math.floor(scrollRef.height / 2))
  }, 0)
}

function Highlight(props: {
  text: string
  query: string
  lineIndex: number
  active: Match | undefined
  theme: TuiThemeCurrent
}): JSX.Element {
  const text = props.text.length > 0 ? props.text : " "
  if (!props.query) return text
  const needle = props.query.toLowerCase()
  const haystack = text.toLowerCase()
  let at = haystack.indexOf(needle)
  if (at === -1) return text

  const nodes: JSX.Element[] = []
  let from = 0
  while (at !== -1) {
    if (at > from) nodes.push(<span>{text.slice(from, at)}</span>)
    const isActive = props.active?.line === props.lineIndex && props.active?.start === at
    nodes.push(
      <span
        style={{
          bg: isActive ? props.theme.primary : props.theme.warning,
          fg: props.theme.background,
          bold: isActive,
        }}
      >
        {text.slice(at, at + props.query.length)}
      </span>,
    )
    from = at + props.query.length
    at = haystack.indexOf(needle, from)
  }
  if (from < text.length) nodes.push(<span>{text.slice(from)}</span>)
  return nodes
}

function Search(props: { api: TuiPluginApi }) {
  const api = props.api
  const dim = useTerminalDimensions()
  const theme = (): TuiThemeCurrent => api.theme.current

  // Messages do not change while searching, so compute the line list once on mount.
  const sessionID = readState(api).sessionID
  const lines = buildLines(api, sessionID)

  return (
    <box
      width={dim().width}
      height={dim().height}
      backgroundColor={theme().background}
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
    >
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={theme().text}>
          <b>Search messages</b>
        </text>
        <text fg={theme().textMuted}>
          {() => {
            const state = readState(api)
            if (!state.query) return ""
            const total = findMatches(lines, state.query).length
            if (total === 0) return "no matches"
            return `${state.active + 1} / ${total}`
          }}
        </text>
      </box>

      <box
        flexShrink={0}
        flexDirection="row"
        gap={1}
        marginTop={1}
        border
        borderColor={theme().border}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={theme().primary}></text>
        <input
          onInput={(value: string) => {
            api.route.navigate(ROUTE, { ...readState(api), query: value, active: 0 })
            const matches = findMatches(lines, value)
            if (matches[0]) scrollToLine(matches[0].line)
          }}
          focusedBackgroundColor={theme().background}
          cursorColor={theme().primary}
          focusedTextColor={theme().text}
          placeholder="Type to search this conversation…"
          placeholderColor={theme().textMuted}
          ref={(r: InputRenderable) => {
            setTimeout(() => {
              if (r && !r.isDestroyed) r.focus()
            }, 1)
          }}
        />
      </box>

      <scrollbox
        flexGrow={1}
        marginTop={1}
        scrollbarOptions={{ visible: true }}
        ref={(r: ScrollBoxRenderable) => (scrollRef = r)}
      >
        {lines.length === 0 ? (
          <text fg={theme().textMuted} paddingTop={1}>
            No messages in this session yet.
          </text>
        ) : (
          lines.map((line, index) => (
            <box
              id={"line-" + index}
              flexShrink={0}
              marginTop={line.first && index > 0 ? 1 : 0}
              border={["left"]}
              borderColor={line.role === "user" ? theme().primary : theme().border}
              paddingLeft={1}
            >
              <text fg={theme().text} wrapMode="word">
                {() => {
                  const state = readState(api)
                  const matches = findMatches(lines, state.query)
                  return Highlight({
                    text: line.text,
                    query: state.query,
                    lineIndex: index,
                    active: matches[state.active],
                    theme: theme(),
                  })
                }}
              </text>
            </box>
          ))
        )}
      </scrollbox>

      <box flexShrink={0} flexDirection="row" gap={2} paddingTop={1} paddingBottom={1}>
        <text fg={theme().textMuted}>↑/↓ or enter · next/prev match</text>
        <text fg={theme().textMuted}>esc · back to session</text>
      </box>
    </box>
  )
}

function buildBindings(config: Record<string, string>) {
  return Object.entries(config).flatMap(([command, keys]) =>
    keys
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean)
      .map((key) => ({ key, cmd: command })),
  )
}

const tui: TuiPlugin = async (api, options) => {
  if (options?.enabled === false) return

  const override =
    options && typeof options.keybinds === "object" && !Array.isArray(options.keybinds)
      ? (options.keybinds as Record<string, string>)
      : undefined
  const keymap = { ...defaultKeymap, ...override }

  api.route.register([
    {
      name: ROUTE,
      render: () => <Search api={api} />,
    },
  ])

  const onRoute = () => api.route.current.name === ROUTE

  const moveMatch = (direction: 1 | -1) => {
    const state = readState(api)
    const matches = findMatches(buildLines(api, state.sessionID), state.query)
    if (matches.length === 0) return
    const next = (state.active + direction + matches.length) % matches.length
    api.route.navigate(ROUTE, { ...state, active: next })
    scrollToLine(matches[next].line)
  }

  const closeSearch = () => {
    const state = readState(api)
    if (state.returnRoute && typeof state.returnRoute === "object" && "name" in state.returnRoute) {
      api.route.navigate(state.returnRoute.name, "params" in state.returnRoute ? state.returnRoute.params : undefined)
      return
    }
    if (state.sessionID) {
      api.route.navigate("session", { sessionID: state.sessionID })
      return
    }
    api.route.navigate("home")
  }

  keymapOf(api).registerLayer({
    commands: [
      {
        name: cmd.open,
        title: "Search messages",
        category: "Session",
        namespace: "palette",
        slashName: "search",
        enabled: () => api.route.current.name === "session",
        run() {
          const route = api.route.current
          const sessionID = route.name === "session" ? route.params.sessionID : ""
          if (!sessionID) {
            api.ui.toast({ variant: "info", title: "Search", message: "Open a session first", duration: 2000 })
            return
          }
          api.route.navigate(ROUTE, { sessionID, returnRoute: route, query: "", active: 0 })
        },
      },
      { name: cmd.next, title: "Next match", category: "Search", enabled: onRoute, run: () => moveMatch(1) },
      { name: cmd.prev, title: "Previous match", category: "Search", enabled: onRoute, run: () => moveMatch(-1) },
      { name: cmd.close, title: "Close search", category: "Search", enabled: onRoute, run: () => closeSearch() },
    ],
    bindings: buildBindings(keymap),
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "search-messages",
  tui,
}

export default plugin
