/**
 * Regression test for the TUI bootstrap aggregation helper. Replaces the
 * pre-fix Promise.all behavior where the first rejection drowned every
 * sibling endpoint's failure as an unhandled rejection.
 */
import { describe, expect, test } from "bun:test"
import { aggregateFailures } from "@/cli/cmd/tui/context/aggregate-failures"

describe("aggregateFailures", () => {
  test("returns null when every result is fulfilled", () => {
    expect(
      aggregateFailures([
        { name: "config", result: { status: "fulfilled", value: 1 } },
        { name: "providers", result: { status: "fulfilled", value: 2 } },
      ]),
    ).toBeNull()
  })

  test("names the failed endpoint when one rejects", () => {
    const err = aggregateFailures([
      { name: "config", result: { status: "fulfilled", value: 1 } },
      {
        name: "providers",
        result: { status: "rejected", reason: new Error("Service unavailable") },
      },
    ])
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain("1 of 2")
    expect(err!.message).toContain("providers: Service unavailable")
  })

  test("names every failed endpoint when multiple reject", () => {
    const err = aggregateFailures([
      { name: "config", result: { status: "rejected", reason: new Error("400 Bad Request") } },
      { name: "providers", result: { status: "fulfilled", value: 1 } },
      { name: "agents", result: { status: "rejected", reason: { message: "boom" } } },
    ])
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain("2 of 3")
    expect(err!.message).toContain("config: 400 Bad Request")
    expect(err!.message).toContain("agents: boom")
  })

  test("attaches structured failure list under .cause", () => {
    const reason = new Error("nope")
    const err = aggregateFailures([{ name: "providers", result: { status: "rejected", reason } }])
    const cause = err!.cause as { failures: Array<{ name: string; reason: unknown }> }
    expect(cause.failures).toEqual([{ name: "providers", reason }])
  })

  test("falls back to String() for opaque reasons", () => {
    const err = aggregateFailures([{ name: "x", result: { status: "rejected", reason: 42 } }])
    expect(err!.message).toContain("x: 42")
  })

  test("surfaces a shared named error as an Error with structured fields", () => {
    const reason = { name: "ConfigInvalidError", data: { message: "bad config" } }
    const result = aggregateFailures([
      { name: "config", result: { status: "rejected", reason } },
      { name: "providers", result: { status: "rejected", reason: { name: "ConfigInvalidError", data: { message: "bad config" } } } },
    ])
    expect(result).toBeInstanceOf(Error)
    expect(result!.name).toBe("ConfigInvalidError")
    expect((result as Error & { data: unknown }).data).toEqual(reason.data)
  })

  test("surfaces a wrapped named error from SDK throwOnError", () => {
    const body = { name: "ConfigInvalidError", data: { issues: [{ message: "expected string", path: ["model"] }] } }
    const reason = new Error("ConfigInvalidError", { cause: { body, status: 400 } })
    const result = aggregateFailures([
      { name: "config", result: { status: "rejected", reason } },
      { name: "providers", result: { status: "rejected", reason } },
    ])
    expect(result).toBeInstanceOf(Error)
    expect(result!.name).toBe("ConfigInvalidError")
    expect((result as Error & { data: unknown }).data).toEqual(body.data)
  })

  test("aggregates when failures have different named error names", () => {
    const result = aggregateFailures([
      { name: "config", result: { status: "rejected", reason: { name: "ConfigInvalidError", data: {} } } },
      { name: "providers", result: { status: "rejected", reason: { name: "ProviderInitError", data: {} } } },
    ])
    expect(result).toBeInstanceOf(Error)
    expect(result!.message).toContain("ConfigInvalidError")
    expect(result!.message).toContain("ProviderInitError")
  })

  test("aggregates generic Errors even when they all share the same name", () => {
    const result = aggregateFailures([
      { name: "a", result: { status: "rejected", reason: new Error("foo") } },
      { name: "b", result: { status: "rejected", reason: new Error("bar") } },
    ])
    expect(result).toBeInstanceOf(Error)
    expect(result!.message).toContain("foo")
    expect(result!.message).toContain("bar")
  })
})
