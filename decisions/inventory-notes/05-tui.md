# Area: tui  (3,994 lines — Ink/React terminal frontend)

A pure NDJSON protocol client. Ships inside desktop artifacts as
`resources/engine/tui.mjs` and runs through Electron's own Node.

## Startup gates (the model the gateway must mirror)

1. **TrustGate** (`trust.ts` 74L + `TrustGate.tsx` 49L) — runs BEFORE the
   profile picker, because picking writes an API key into `<ws>/.env` and that
   must never land in an unvouched folder. Store is GLOBAL
   (`~/.magentra/trusted-folders.json`, 0600) — a marker file inside the
   workspace would be worthless, since the folder being judged could ship one
   and cloning a repo would pre-trust it. `isTrusted` matches on path SEGMENTS
   with ancestor inheritance, so `/home/me/work` never trusts
   `/home/me/workspace`. Saying yes also turns OVERDRIVE on for the session,
   which is why the copy is blunt rather than softened.
2. **ProfilePicker** (`profiles.ts` 173L + `ProfilePicker.tsx` 44L) — shown only
   when the folder has no credentials AND saved profiles exist. Up to 9 rows,
   `↑↓ · ↵ · 1-9 · esc continue without`. Keys never displayed. Applying writes
   the same two files the IDE writes: key → `<ws>/.env`, connection →
   `<ws>/.magentra/settings.json`. `workspaceConnected(ws)` = presence check
   over env vars, an `.env` API_KEY line, or a settings.json naming a
   connection. **No network probe.**
3. **Neither** → a note naming the store: "no credentials in this folder and no
   saved profiles (~/.magentra/profiles.json)", then boot anyway so the ENGINE
   reports its own missing-key error.

## Layout core

`markdown.ts` (386L) — owns wrapping and column arithmetic in **display CELLS**,
because Ink lays `<Static>` out as an absolutely positioned content-sized box
where `flexGrow` never reaches the right edge. displayWidth, truncate,
truncateStart, pad, inlineSpans, configureMarks, wrapSpans, blockOf, blockBody,
layoutLine. The no-reflow guarantee: the live streaming line and the committed
line are laid out by the SAME function at the SAME width, so a paragraph reaches
final shape while it streams.

## Rest

- `useEngine.ts` (1,019L) — the whole client: PendingPrompt, Meters,
  BackgroundJob, spawn/handshake, all frame handling, pickers, resume.
- `app.tsx` (524L) — keyboard ownership, chooser arbitration, gates.
- `cli.tsx` (75L) — `magentra [path] [--resume [id]] [--gui]`. GUI handoff:
  `--gui` or no interactive TTY hands over to the desktop app and exits (the
  Windows cmd shim cannot test for a TTY, so the TUI is the universal fallback).
  Platform-specific GUI binary resolution (Windows MAGENTRA.exe, Linux sibling
  `magentra` wrapper for sandbox detection).
- 11 components: Activity, CommandPalette, Composer, LiveLine, ProfilePicker,
  Prompt, SessionPicker, TaskStrip, ToolTail, TranscriptLine (343L, right-align
  by hand from terminal width), TrustGate.
- `protocol.ts` (190L) — a **hand-copied duplicate** of the protocol types
  (PROTOCOL_VERSION, CoreEvent, FrontendRequest …). A second definition of the
  wire contract that nothing keeps in step with `engine/protocol`.
- `theme.ts` (129L) — campbell palette, glyphs, spinner frames, layout,
  SPEAKER_MARKER/INDENT. `config.ts` (109L) — engine spawn resolution,
  packaged vs dev. `host.ts` (95L) — process host. `toolLabel.ts`, `format.ts`,
  `types.ts`.
