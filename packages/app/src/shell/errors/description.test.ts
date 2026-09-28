import { describe, expect, test } from "bun:test"
import { errorDescriptionKey, errorStatus, localServerStartupReason } from "./description"

describe("error description", () => {
  test("describes local server startup errors", () => {
    expect(errorDescriptionKey(Object.assign(new Error("migration failed"), { localServerStartup: true }))).toBe(
      "error.page.description.localServerStartup",
    )
  })

  test("uses the generic description for other errors", () => {
    expect(errorDescriptionKey(new Error("unknown"))).toBe("error.page.description")
    expect(errorDescriptionKey(Object.assign(new Error("unknown"), { localServerStartup: false }))).toBe(
      "error.page.description",
    )
  })
})

describe("local server startup reason", () => {
  test("finds the reason the service wrote to stderr", () => {
    const exited = new Error(
      "Server process exited with code 78\nError: Managed service port 49374 on 127.0.0.1 is already in use.\n    at start (server.js:1:1)",
    )
    const error = Object.assign(
      new Error("Desktop IPC handler failed", {
        cause: new Error("Timed out waiting for the background service to start", { cause: exited }),
      }),
      { localServerStartup: true },
    )
    expect(localServerStartupReason(error)).toBe("Managed service port 49374 on 127.0.0.1 is already in use.")
  })

  test("ignores other errors and startup errors without a reported reason", () => {
    expect(localServerStartupReason(new Error("x", { cause: new Error("exited\nError: reason") }))).toBeUndefined()
    expect(
      localServerStartupReason(Object.assign(new Error("Timed out waiting"), { localServerStartup: true })),
    ).toBeUndefined()
  })
})

describe("error status", () => {
  test("finds status codes in an error cause", () => {
    expect(errorStatus(new Error("UnexpectedStatus", { cause: { status: 502 } }))).toBe(502)
  })

  test("finds status codes in structured error data", () => {
    expect(errorStatus({ name: "APIError", data: { statusCode: 401 } })).toBe(401)
  })

  test("ignores invalid and circular status values", () => {
    const error: { status: number; cause?: unknown } = { status: 99 }
    error.cause = error
    expect(errorStatus(error)).toBeUndefined()
  })
})
