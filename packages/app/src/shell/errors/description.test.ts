import { describe, expect, test } from "bun:test"
import { errorDescriptionKey, errorPortConflict, errorStatus } from "./description"

describe("error description", () => {
  test("describes local server startup errors", () => {
    expect(errorDescriptionKey(Object.assign(new Error("migration failed"), { localServerStartup: true }))).toBe(
      "error.page.description.localServerStartup",
    )
  })

  test.each([new Error("unknown"), Object.assign(new Error("unknown"), { localServerStartup: false })])(
    "uses the generic description for other errors",
    (error) => {
      expect(errorDescriptionKey(error)).toBe("error.page.description")
    },
  )
})

describe("local server port conflict", () => {
  const message = "Managed service port 49374 on 127.0.0.1 is already in use by another process."

  test.each([
    [
      Object.assign(
        new Error(message, {
          cause: { _tag: "LocalServerPortConflict", hostname: "127.0.0.1", port: 49374, message },
        }),
        { localServerStartup: true },
      ),
      49374,
    ],
    [Object.assign(new Error(message), { localServerStartup: true }), undefined],
  ])("offers recovery for a typed conflict, never matching error text alone", (error, port) => {
    expect(errorPortConflict(error)).toBe(port)
  })
})

describe("error status", () => {
  test.each([
    [new Error("UnexpectedStatus", { cause: { status: 502 } }), 502],
    [{ name: "APIError", data: { statusCode: 401 } }, 401],
  ])("finds status codes in an error cause or structured data", (error, status) => {
    expect(errorStatus(error)).toBe(status)
  })

  test("ignores invalid and circular status values", () => {
    const error: { status: number; cause?: unknown } = { status: 99 }
    error.cause = error
    expect(errorStatus(error)).toBeUndefined()
  })
})
