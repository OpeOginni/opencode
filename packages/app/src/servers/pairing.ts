export type PairingIntent = {
  server: string
  ticket: string
  directory?: string
}

export function isPairingLink(input: string) {
  if (!URL.canParse(input)) return false
  const url = new URL(input)
  return (url.protocol === "opencode:" && url.hostname === "connect") || url.hash.startsWith("#pair?")
}

export function parsePairingIntent(input: string): PairingIntent | undefined {
  if (!URL.canParse(input)) return
  const url = new URL(input)
  const params =
    url.protocol === "opencode:" && url.hostname === "connect"
      ? url.searchParams
      : url.hash.startsWith("#pair?")
        ? new URLSearchParams(url.hash.slice("#pair?".length))
        : undefined
  if (!params) return
  const ticket = params.get("ticket")
  const directory = params.get("directory")?.trim() || undefined
  if (!ticket || ticket.length > 4096) return
  if (directory && (directory.length > 32_768 || !absolute(directory))) return

  const value = params.get("server")
  if (!value || value.length > 2048 || !URL.canParse(value)) return
  const server = new URL(value)
  if (server.protocol !== "http:" && server.protocol !== "https:") return
  if (server.username || server.password || server.search || server.hash) return
  return { server: server.toString().replace(/\/+$/, ""), ticket, directory }
}

function absolute(input: string) {
  return input.startsWith("/") || /^[A-Za-z]:[\\/]/.test(input) || input.startsWith("\\\\")
}
