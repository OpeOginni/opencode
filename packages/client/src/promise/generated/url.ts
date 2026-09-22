export function resolveUrl(baseUrl: string, path: string) {
  const url = new URL(baseUrl)
  url.pathname = url.pathname.replace(/\/$/, "") + "/" + path.replace(/^\//, "")
  url.search = ""
  url.hash = ""
  return url
}
