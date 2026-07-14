import { describe, expect, test } from "bun:test"
import {
  recentConnectedWorkspaces,
  remoteWorkspaceAdapters,
} from "../../../../src/component/dialog-workspace-create"

describe("remoteWorkspaceAdapters", () => {
  const adapters = [
    { type: "worktree", kind: "local", name: "Worktree" },
    { type: "remote", kind: "remote", name: "Remote" },
    { type: "gitterm", kind: "remote", name: "Gitterm" },
    { type: "acme", kind: "remote", name: "Acme Cloud" },
  ]

  test("keeps only plugin-registered remote adapters, sorted by name", () => {
    expect(remoteWorkspaceAdapters(adapters).map((adapter) => adapter.type)).toEqual(["acme", "gitterm"])
  })

  test("excludes the built-in remote and worktree adapters", () => {
    const types = remoteWorkspaceAdapters(adapters).map((adapter) => adapter.type)
    expect(types).not.toContain("remote")
    expect(types).not.toContain("worktree")
  })

  test("returns empty when no plugin remote adapters are registered", () => {
    expect(
      remoteWorkspaceAdapters([
        { type: "worktree", kind: "local", name: "Worktree" },
        { type: "remote", kind: "remote", name: "Remote" },
      ]),
    ).toEqual([])
  })
})

describe("recentConnectedWorkspaces", () => {
  test("returns connected and paused workspaces sorted by time used", () => {
    const workspaces = [
      { id: "wrk_a", name: "alpha", timeUsed: 700 },
      { id: "wrk_b", name: "beta", timeUsed: 800 },
      { id: "wrk_c", name: "gamma", timeUsed: 400 },
      { id: "wrk_d", name: "delta", timeUsed: 300 },
      { id: "wrk_e", name: "epsilon", timeUsed: 200 },
    ]
    const status = {
      wrk_a: "connected",
      wrk_b: "paused",
      wrk_c: "error",
      wrk_d: "connected",
      wrk_e: "connected",
    } as const

    const { recent } = recentConnectedWorkspaces({
      workspaces,
      status: (workspaceID) => status[workspaceID as keyof typeof status],
    })

    expect(recent.map((workspace) => workspace.id)).toEqual(["wrk_b", "wrk_a", "wrk_d"])
  })
})
