#!/usr/bin/env bun

import { $ } from "bun"
import pkg from "../package.json"

const value = (name: string) => {
  const prefix = `--${name}=`
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

if (process.argv.includes("--help")) {
  console.log(`Usage: bun run build:workspace-image [options]

Options:
  --image=<name>       Image repository (default: opeoginni/opencode-remote-workspace)
  --version=<version>  Versioned image tag (default: OPENCODE_VERSION or ${pkg.version}-workspaces.0)
  --platform=<list>    Docker platforms (local architecture, or both when --push)
  --push               Push a multi-architecture image instead of loading locally
  --skip-login         Reuse existing Docker Hub authentication when pushing
  --no-latest          Do not also tag the image as latest
  --help               Show this help`)
  process.exit(0)
}

const push = process.argv.includes("--push")
const image = value("image") ?? "opeoginni/opencode-remote-workspace"
const version = value("version") ?? process.env.OPENCODE_VERSION ?? `${pkg.version}-workspaces.0`
const platform =
  value("platform") ?? (push ? "linux/amd64,linux/arm64" : `linux/${process.arch === "arm64" ? "arm64" : "amd64"}`)
const refs = [
  `${image}:${version}`,
  ...(process.argv.includes("--no-latest") || version === "latest" ? [] : [`${image}:latest`]),
]

console.log(`Building opencode binaries for ${refs.join(", ")}`)
await $`OPENCODE_VERSION=${version} bun run script/build.ts --workspace-image --workspace-version=${version}`

if (push && !process.argv.includes("--skip-login")) {
  console.log("Sign in to Docker Hub in your browser to continue pushing.")
  await $`docker login`
}

console.log(`${push ? "Pushing" : "Loading"} ${refs.join(", ")} for ${platform}`)
const output = push ? "--push" : "--load"
const tags = refs.flatMap((ref) => ["-t", ref])
await $`docker buildx build --platform ${platform} --build-arg VERSION=${version} -f Dockerfile.workspace ${tags} ${output} .`

console.log(`${push ? "Pushed" : "Built"} ${refs.join(", ")}`)

// OPENCODE_VERSION=1.17.20-workspaces.5 bun run build:workspace-image --push
