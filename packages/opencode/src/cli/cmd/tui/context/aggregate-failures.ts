/**
 * Aggregate Promise.allSettled results into a single Error that names every
 * failed endpoint, or return null when all fulfilled. Used at TUI bootstrap
 * boundaries so a single 4xx doesn't drown its parallel siblings as
 * unhandled rejections — every failure surfaces in one labeled message.
 */
export type LabeledSettled = {
  name: string
  result: PromiseSettledResult<unknown>
}

export function aggregateFailures(labeled: LabeledSettled[]): Error | null {
  const failed = labeled.filter(
    (x): x is { name: string; result: PromiseRejectedResult } => x.result.status === "rejected",
  )
  if (failed.length === 0) return null

  const named = failed.map((f) => namedError(f.result.reason))
  const name = named[0]?.name
  if (typeof name === "string" && named.every((item) => item?.name === name)) {
    return Object.assign(new Error(name), named[0])
  }

  const reasons = failed.map((f) => `${f.name}: ${reasonMessage(f.result.reason)}`).join("; ")
  const summary = `${failed.length} of ${labeled.length} requests failed: ${reasons}`
  const err = new Error(summary)
  err.cause = { failures: failed.map((f) => ({ name: f.name, reason: f.result.reason })) }
  return err
}

function namedError(reason: unknown): { name: unknown } | undefined {
  const value = reason instanceof Error && reason.cause && typeof reason.cause === "object" && "body" in reason.cause
    ? reason.cause.body
    : reason
  if (!value || typeof value !== "object" || !("name" in value)) return undefined
  return value
}

function reasonMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  if (typeof reason === "string") return reason
  if (reason && typeof reason === "object") {
    const obj = reason as { message?: unknown; name?: unknown }
    if (typeof obj.message === "string") return obj.message
    if (typeof obj.name === "string") return obj.name
  }
  return String(reason)
}
