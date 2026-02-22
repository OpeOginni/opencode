# OpenCode Desktop

Native OpenCode desktop app, built with Tauri v2.

---

## Development

From the repo root:

```bash
bun install
bun run --cwd packages/desktop tauri dev
```

This starts the Vite dev server on http://localhost:1420 and opens the native window.

If you only want the web dev server (no native shell):

```bash
bun run --cwd packages/desktop dev
```

---

## Build

To create a production `dist/` and build the native app bundle:

```bash
bun run --cwd packages/desktop tauri build
```

---

## Configure shell

Set `OPENCODE_SIDECAR_SHELL` to `login` (default) or `interactive` (`il`).
Use `interactive` if the desktop terminal can’t find tools (e.g., `bun`, `node`, `git`, `python`) because your PATH is initialized in `.zshrc`/`.bashrc`.

Login shell example:

```bash
export OPENCODE_SIDECAR_SHELL=login
```

Interactive shell example:

```bash
export OPENCODE_SIDECAR_SHELL=interactive
```

---

## Prerequisites

Running the desktop app requires additional Tauri dependencies (Rust toolchain, platform-specific libraries). See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for setup instructions.
