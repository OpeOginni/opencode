import type { PlatformError } from "effect/PlatformError"

// Effect maps EACCES to PermissionDenied, but macOS privacy blocks report EPERM as Unknown.
export function isPermissionDenied(error: PlatformError) {
  if (error.reason._tag === "PermissionDenied") return true
  const cause = error.cause
  return (
    error.reason._tag === "Unknown" &&
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "EPERM"
  )
}
