#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs"
import path from "path"
import pkg from "../package.json"

const value = (name: string) => {
  const prefix = `--${name}=`
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

if (process.argv.includes("--help")) {
  console.log(`Usage: bun run build:workspace-npm [options]

Options:
  --name=<name>        Package name (default: @gitterm/opencode-workspace)
  --version=<version>  Package version (default: OPENCODE_VERSION or ${pkg.version}-workspaces.0)
  --tag=<tag>          npm dist-tag used with --publish (default: latest)
  --skip-build         Reuse existing platform binaries in dist
  --skip-login         Reuse existing npm authentication instead of browser login
  --publish            Publish the package to npm
  --help               Show this help`)
  process.exit(0)
}

const name = value("name") ?? "@gitterm/opencode-workspace"
const version = value("version") ?? process.env.OPENCODE_VERSION ?? `${pkg.version}-workspaces.0`
const tag = value("tag") ?? "latest"
const publish = process.argv.includes("--publish")
const output = path.resolve("dist/opencode-remote-workspace")

if (!process.argv.includes("--skip-build")) {
  await $`OPENCODE_VERSION=${version} bun run script/build.ts --workspace-version=${version}`
}

const binaries = [
  { platform: "darwin", arch: "arm64", source: "dist/opencode-darwin-arm64/bin/opencode" },
  { platform: "darwin", arch: "x64", source: "dist/opencode-darwin-x64-baseline/bin/opencode" },
  { platform: "linux", arch: "arm64", source: "dist/opencode-linux-arm64/bin/opencode" },
  { platform: "linux", arch: "x64", source: "dist/opencode-linux-x64-baseline/bin/opencode" },
  { platform: "win32", arch: "arm64", source: "dist/opencode-windows-arm64/bin/opencode.exe" },
  { platform: "win32", arch: "x64", source: "dist/opencode-windows-x64-baseline/bin/opencode.exe" },
]
const missing = binaries.filter((binary) => !fs.existsSync(binary.source))
if (missing.length > 0) throw new Error(`Missing binaries: ${missing.map((binary) => binary.source).join(", ")}`)
const packages = binaries.map((binary) => ({
  ...binary,
  name: `${name}-${binary.platform}-${binary.arch}`,
  output: `${output}-${binary.platform}-${binary.arch}`,
}))

await $`rm -rf ${output}`
await Promise.all(packages.map((pkg) => $`rm -rf ${pkg.output}`))
await $`mkdir -p ${output}/bin`
await $`cp ../../LICENSE ${output}/LICENSE`
await Promise.all(
  packages.map(async (pkg) => {
    const binary = `opencode${pkg.platform === "win32" ? ".exe" : ""}`
    await $`mkdir -p ${pkg.output}/bin`
    await $`cp ${pkg.source} ${pkg.output}/bin/${binary}`
    await $`cp ../../LICENSE ${pkg.output}/LICENSE`
    await Bun.write(
      path.join(pkg.output, "package.json"),
      JSON.stringify(
        {
          name: pkg.name,
          version,
          description: `opencode remote-workspace binary for ${pkg.platform}-${pkg.arch}`,
          license: "MIT",
          os: [pkg.platform],
          cpu: [pkg.arch],
          files: ["bin", "LICENSE"],
          repository: {
            type: "git",
            url: "git+https://github.com/OpeOginni/opencode.git",
          },
        },
        null,
        2,
      ),
    )
  }),
)

await Bun.write(
  path.join(output, "bin/opencode-remote-workspace.js"),
  `#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"

const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : undefined
const arch = process.arch === "arm64" || process.arch === "x64" ? process.arch : undefined
if (!platform || !arch) {
  console.error(\`Unsupported platform: \${process.platform} \${process.arch}\`)
  process.exit(1)
}

const packages = ${JSON.stringify(Object.fromEntries(packages.map((pkg) => [`${pkg.platform}-${pkg.arch}`, pkg.name])))}
const packageName = packages[\`\${platform}-\${arch}\`]
if (!packageName) {
  console.error(\`No binary package is available for \${platform}-\${arch}\`)
  process.exit(1)
}

const require = createRequire(import.meta.url)
const binary = require.resolve(\`\${packageName}/bin/opencode\${platform === "win32" ? ".exe" : ""}\`)
const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" })
if (result.error) throw result.error
if (result.signal) {
  process.kill(process.pid, result.signal)
}
process.exit(result.status ?? 1)
`,
)

await Bun.write(
  path.join(output, "package.json"),
  JSON.stringify(
    {
      name,
      version,
      description: "Beta remote-workspace build of opencode",
      type: "module",
      license: "MIT",
      bin: { "opencode-workspace": "bin/opencode-remote-workspace.js" },
      files: ["bin", "LICENSE", "README.md"],
      engines: { node: ">=18" },
      optionalDependencies: Object.fromEntries(packages.map((pkg) => [pkg.name, version])),
      publishConfig: { access: "public" },
      repository: {
        type: "git",
        url: "git+https://github.com/OpeOginni/opencode.git",
      },
      homepage: "https://github.com/OpeOginni/opencode",
      bugs: "https://github.com/OpeOginni/opencode/issues",
    },
    null,
    2,
  ),
)

await Bun.write(
  path.join(output, "README.md"),
  `# ${name}

Beta build of [opencode](https://github.com/anomalyco/opencode) with remote workspace support.

## Install

\`\`\`bash
npm install --global ${name}@${version}
opencode-workspace serve --hostname 0.0.0.0 --port 4096
\`\`\`

This package ships binaries for macOS, Linux, and Windows on x64 and arm64.

## Container image

\`\`\`bash
docker run --rm -p 4096:4096 -v "$PWD:/workspace" opeoginni/opencode-remote-workspace:${version}
\`\`\`
`,
)

await $`chmod 755 ${output}/bin/opencode-remote-workspace.js`
await Promise.all(
  packages.filter((pkg) => pkg.platform !== "win32").map((pkg) => $`chmod 755 ${pkg.output}/bin/opencode`),
)

if (publish) {
  if (!process.argv.includes("--skip-login")) {
    console.log("Sign in with npm in your browser to continue publishing.")
    await $`npm login --auth-type=web`
  }
  const publishPackage = async (pkg: { name: string; output: string }) => {
    if ((await $`npm view ${pkg.name}@${version} version`.quiet().nothrow()).exitCode === 0) {
      console.log(`Already published ${pkg.name}@${version}`)
      return
    }
    await $`npm publish --access public --tag ${tag}`.cwd(pkg.output)
  }
  for (const pkg of packages) {
    await publishPackage(pkg)
  }
  await publishPackage({ name, output })
  console.log(`Published ${name}@${version} with dist-tag ${tag}`)
} else {
  console.log(`Built ${name}@${version} in ${output}`)
}

// Automated publishing (recommended):
// OPENCODE_VERSION=1.18.0-workspaces.1 bun run build:workspace-npm
//
// Manual publishing after a build:
// for package in dist/opencode-remote-workspace-{darwin-arm64,darwin-x64,linux-arm64,linux-x64,win32-arm64,win32-x64}; do
//   (cd "$package" && npm publish --access public --tag latest)
// done
// (cd dist/opencode-remote-workspace && npm publish --access public --tag latest)
