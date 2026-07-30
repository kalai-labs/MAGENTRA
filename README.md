# MAGENTRA

An autonomous agent harness. One product: a desktop app (Windows `.exe`, Linux
AppImage/tar.gz, macOS `.dmg`) wrapped around an agent engine that plans, edits
code, runs commands, and dispatches specialist sub-agents.

## Install

Every release ships prebuilt binaries on the
[GitHub Releases](../../releases) page:

- **Windows** — `MAGENTRA-<version>-win-portable.exe`, a portable exe (no
  installer). It is unsigned, so SmartScreen may object on first run: click
  **More info → Run anyway**.
- **Linux** — `MAGENTRA-<version>-linux-x64.tar.gz` or
  `MAGENTRA-<version>-linux-x64.AppImage`. For the tar.gz: extract it and run
  `./magentra` — that launcher is a small wrapper that checks whether Chromium
  can sandbox itself on your system and passes `--no-sandbox` only when it
  genuinely cannot (e.g. distros that restrict unprivileged user namespaces).
- **macOS** — `MAGENTRA-<version>-mac-arm64.dmg` (Apple Silicon only). The app
  is unsigned, so the first launch needs **right-click → Open** instead of a
  double-click.

## Layout

```
engine/            The agent engine. TypeScript, npm workspaces, no UI.
  protocol/        The wire contract: CoreEvent / FrontendRequest, NDJSON framing.
  providers/       LLM providers (Anthropic, OpenAI-compatible) + retry.
  core/            The engine itself — see below.
  tools/           The tools an agent can call (Read, Write, Bash, Grep, …).
  host/            Headless process: runs the engine, speaks NDJSON over stdio.

app/               The desktop app (Electron). The engine's only frontend.
  main.js          Main process: window, engine child process, IPC.
  main/            Pure pieces of the main process (config, logging).
  preload.js       The contextBridge surface the renderer is allowed to touch.
  renderer/        The UI. modules/ are classic scripts, loaded in order.
  scripts/         Build: bundles the engine + minifies the app for packaging.

docs/              Architecture, protocol, tools, and the skill format.
tools/version/     The version tool (see VERSIONING.md).
FEATURES.md        Every feature, and whether it has a real test yet.
```

### Inside `engine/core`

| Folder          | What lives there                                                  |
| --------------- | ----------------------------------------------------------------- |
| `runtime/`      | The turn loop (`session`), the protocol endpoint (`engine`), permissions, session accounting. |
| `agent/`        | What an agent *is*: system prompt, tool contract, subagent types, skills, hooks. |
| `config/`       | Layered settings, and the model rate card used for cost.          |
| `knowledge/`    | How the agent learns a codebase: atlas, import graph, symbols, docs, the reuse gate. |
| `ma/`           | The discipline-skill system (`.magentra/skills/*.md`) and oracle-script debugging. |
| `scheduling/`   | Work that runs later: cron, background jobs, workflows. |
| `state/`        | What persists: the transcript, the task list.                     |
| `integrations/` | The outside world (MCP servers).                                  |

## Build and run

```sh
npm install
npm run build        # compile the engine (tsc -b)
npm run app          # launch the desktop app against the built engine
```

## Package

```sh
npm run dist:linux   # AppImage + tar.gz
npm run dist:win     # portable .exe
npm run dist:mac     # arm64 .dmg
```

All bundle the engine into a single file and ship a `ripgrep` binary beside it,
so the artifact needs no `node_modules` at runtime.

## Versioning

Semantic (`MAJOR.MINOR.PATCH`), driven by commit messages. You do not pick the
number — the commits do. A break is MAJOR, a `feat` is MINOR, everything else is
PATCH. See [VERSIONING.md](VERSIONING.md). Commit with:

```sh
npm run commit
```

## Updates

The app checks GitHub for a newer release on launch and every six hours, and puts
what it finds at the bottom of the inspector. Nothing downloads until you click.

Windows installer and Linux AppImage builds update themselves in one click. The
macOS `.dmg`, the Windows portable `.exe`, the `.deb` and the `.tar.gz` cannot
replace a running unsigned app, so one click downloads the right file for your
install instead. See
[docs/adr/0009-updates-have-two-tiers.md](docs/adr/0009-updates-have-two-tiers.md).

Set `"updateCheck": false` in the app's `config.json` to turn the check off.
