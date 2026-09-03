import { describe, expect, test } from "bun:test"
import { parsePairingIntent } from "./pairing"

describe("pairing intent", () => {
  test("parses credentials and an absolute directory from the fragment", () => {
    const params = new URLSearchParams({
      server: "https://server.example.com/",
      ticket: "ticket & value",
      directory: "/workspace/project",
    })
    expect(parsePairingIntent(`https://app.opencode.ai/#pair?${params}`)).toEqual({
      server: "https://server.example.com",
      ticket: "ticket & value",
      directory: "/workspace/project",
    })
    expect(parsePairingIntent(`opencode://connect?${params}`)).toEqual({
      server: "https://server.example.com",
      ticket: "ticket & value",
      directory: "/workspace/project",
    })
  })

  test("rejects unsafe servers and relative directories", () => {
    expect(
      parsePairingIntent("https://app.opencode.ai/#pair?server=https%3A%2F%2Fuser%3Apass%40example.com&ticket=secret"),
    ).toBeUndefined()
    expect(
      parsePairingIntent(
        "https://app.opencode.ai/#pair?server=https%3A%2F%2Fexample.com%3Ftoken%3Dsecret&ticket=secret",
      ),
    ).toBeUndefined()
    expect(
      parsePairingIntent(
        "https://app.opencode.ai/#pair?server=https%3A%2F%2Fexample.com&ticket=secret&directory=relative",
      ),
    ).toBeUndefined()
  })
})
