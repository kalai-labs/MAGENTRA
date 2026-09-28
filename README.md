# MAGENTRA

An autonomous agent harness. One product: a desktop app (Windows `.exe`, macOS
`.dmg`) and a terminal UI, both wrapped around one agent engine that plans,
edits code, runs commands, and dispatches specialist sub-agents.

## Install

Every release ships prebuilt binaries on the
[GitHub Releases](../../releases) page:

- **Windows** — `MAGENTRA-<version>-win-setup.exe` (installer; also installs
  the `magentra` terminal command, see below) or
  `MAGENTRA-<version>-win-portable.exe`, a portable exe with no installer and
  no terminal command. Both are unsigned, so SmartScreen may object on first
  run: click **More info → Run anyway**.
- **macOS** — `MAGENTRA-<version>-mac-arm64.dmg` (Apple Silicon only). Open the
  dmg and drag **MAGENTRA** into **Applications**. The app is signed ad hoc but
  not notarized by Apple, so the first launch is blocked once:
  1. Open MAGENTRA. macOS says *"Apple could not verify 'MAGENTRA' is free of
     malware…"* — click **Done**.
  2. Open **System Settings → Privacy & Security**, scroll down to
     **Security**, and click **Open Anyway** beside the MAGENTRA message.
  3. Confirm with **Open Anyway** (and your password if asked). From then on it
     opens with a normal double-click.

  **No administrator rights?** Dragging into `/Applications` and *Open Anyway*
  both ask for an admin password. Instead, drag MAGENTRA into your own
  **Applications** folder in your home folder (`~/Applications`; create it if it
  is missing), then clear the download flag once — your own file, so no
  password:
  ```sh
  xattr -dr com.apple.quarantine ~/Applications/MAGENTRA.app
  ```

  v0.19.4 and earlier were not signed correctly and report *"MAGENTRA is
  damaged and can't be opened"* instead; install a newer release, or clear the
  download flag once with
  `xattr -dr com.apple.quarantine /Applications/MAGENTRA.app`.

## The `magentra` terminal command

Every artifact ships a terminal UI alongside the desktop app — the same agent,
the same engine, in your shell instead of a window:

```
magentra                open the agent in the current directory
magentra <path>         open it in that directory
magentra --resume       pick up a previous session in this workspace
magentra --resume <id>  resume that session directly
magentra --gui          open the desktop app instead
```

One name, context-aware: run from an **interactive terminal**, `magentra`
opens the terminal UI right there; launched from the desktop (Start Menu, Dock,
double-click — no TTY), the same name opens the GUI.

How it gets on PATH per platform:

- **Windows**: the `-win-setup.exe` installer writes `bin\magentra.cmd` beside
  the app and adds it to your user PATH (removed on uninstall — note: an
  elevated all-users install updates the installing user's PATH only). The
  portable exe does not provide the command. Open a new terminal after
  installing.
- **macOS**: one symlink:
  ```sh
  sudo ln -s "/Applications/MAGENTRA.app/Contents/Resources/bin/magentra" /usr/local/bin/magentra
  ```
  Without admin rights (app in `~/Applications`), link it into a folder you own
  that is on your PATH, e.g. `~/.local/bin`:
  ```sh
  mkdir -p ~/.local/bin && ln -s ~/Applications/MAGENTRA.app/Contents/Resources/bin/magentra ~/.local/bin/magentra
  ```

The terminal UI needs no separate configuration: it boots the same bundled
engine from the same workspace files (`.env` + `.magentra/settings.json`) the
desktop app writes, and offers your saved connection profiles when you open a
folder that has none.

## Layout

```
engine/            The agent engine. TypeScript, npm workspaces, no UI.
  protocol/        The wire contract: CoreEvent / FrontendRequest, NDJSON framing.
  providers/       LLM providers (Anthropic, OpenAI-compatible) + retry.
  core/            The engine itself — see below.
  tools/           The tools an agent can call (Read, Write, Bash, Grep, …).
  host/            Headless process: runs the engine, speaks NDJSON over stdio.

app/               The desktop app (Electron). One of the engine's two frontends.
  main.js          Main process: windows, the engine pool, IPC.
  main/            Pieces of the main process (config, connection, profiles,
                   logging, updates, changes).
  preload.js       The contextBridge surface the renderer is allowed to touch.
  renderer/        The UI. modules/ are classic scripts, loaded in order.
  scripts/         Build: bundles the engine + TUI + minifies the app for packaging.

tui/               The terminal UI (ink). The engine's other frontend — a pure
                   NDJSON protocol client, shipped inside every artifact as
                   resources/engine/tui.mjs and opened by the `magentra`
                   terminal command.

tests/             The feature suite: one file per feature in features/, the
                   gateway's records in gateway/. See tests/README.md.
tools/             Dev tooling, never shipped: the feature gateway, the version
                   tool (see VERSIONING.md), the approved-artifact regenerator.
benchmarks/        Benchmark prompts and the Terminal-Bench harness.

docs/
  big-picture/     The system map: BIG-PICTURE.md (how it works and why) and
                   MAP.md (generated per-file index).
  adr/             Product architecture decisions.
  decisions/       Decisions about the feature gateway and the test suite.

AGENTS.md          Orientation and working rules for coding agents.
CONTEXT.md         The glossary — the words the code assumes you know.
FEATURES.md        Every feature, and whether it has a real test yet.
```

### Inside `engine/core`

| Folder          | What lives there                                                  |
| --------------- | ----------------------------------------------------------------- |
| `runtime/`      | The turn loop (`session`), the protocol endpoint (`engine`), permissions, session accounting. |
| `agent/`        | What an agent *is*: system prompt, tool contract, subagent types, addons, hooks. |
| `config/`       | Layered settings, and the model rate card used for cost.          |
| `knowledge/`    | How the agent learns a codebase: import graph, symbols, docs, the reuse gate. |
| `scheduling/`   | Work that runs later: cron, background jobs, workflows. |
| `state/`        | What persists: the transcript, the task list.                     |
| `integrations/` | The outside world (MCP servers).                                  |

## Build and run

```sh
npm install
npm run build        # compile the engine and the TUI (tsc -b)
npm run app          # launch the desktop app against the built engine
npm test             # the feature suite; build first — it runs the built engine
```

Before changing anything, read [AGENTS.md](AGENTS.md) and
[docs/big-picture/BIG-PICTURE.md](docs/big-picture/BIG-PICTURE.md).

## Package

```sh
npm run dist:win     # installer + portable .exe
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

The Windows installer build updates itself in one click. The macOS `.dmg` and
the Windows portable `.exe` cannot replace a running unsigned app, so one click
downloads the right file for your install instead. See
[docs/adr/0009-updates-have-two-tiers.md](docs/adr/0009-updates-have-two-tiers.md).

Set `"updateCheck": false` in the app's `config.json` to turn the check off.

## Licence

MAGENTRA is open source under the [Apache Licence 2.0](LICENSE). You may use it,
change it and build products on it, commercially too, as long as you keep the
[NOTICE](NOTICE) and the licence with your copy.

MAGENTRA is owned by Muhammet Ali Öztürk, who holds all rights in the project,
its name and its code, except the copyright in code that others contribute.
Contributions come in under the Apache Licence 2.0 and cannot be withdrawn — see
[CONTRIBUTING.md](CONTRIBUTING.md#licence). The owner may change the licence of
future versions, or stop publishing them and continue MAGENTRA as a private
product. A version that is already published stays available under the Apache
Licence 2.0, and that cannot be taken back.
