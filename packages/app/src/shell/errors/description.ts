export function errorDescriptionKey(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "localServerStartup" in error &&
    error.localServerStartup === true
  ) {
    return "error.page.description.localServerStartup" as const
  }
  return "error.page.description" as const
}

// A service process that fails during startup writes its reason to stderr, and the client appends that output
// to the exit error. Its first error line is the actionable part, such as a port held by another program.
export function localServerStartupReason(error: unknown) {
  if (errorDescriptionKey(error) !== "error.page.description.localServerStartup") return
  const seen = new Set<object>()
  const visit = (value: unknown): string | undefined => {
    if (!(value instanceof Error) || seen.has(value)) return
    seen.add(value)
    const line = value.message
      .split("\n")
      .slice(1)
      .map((item) => item.trim())
      .find((item) => /^\w*Error: /.test(item))
    return line?.replace(/^\w*Error: /, "") ?? visit(value.cause)
  }
  return visit(error)
}

export function errorStatus(error: unknown) {
  const seen = new Set<object>()
  const visit = (value: unknown): number | undefined => {
    if (typeof value !== "object" || value === null || seen.has(value)) return
    seen.add(value)
    const item = value as Record<string, unknown>

    for (const key of ["status", "statusCode"] as const) {
      const status = item[key]
      if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) return status
    }

    return visit(item.cause) ?? visit(item.data)
  }

  return visit(error)
}
