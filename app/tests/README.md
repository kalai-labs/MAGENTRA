# Desktop UI tests

Run the complete desktop suite from the repository root:

```sh
npm run test:ui
```

These are interaction tests, not markup snapshots or generated scaffolds. The
suite boots the real `renderer/index.html` and every production renderer module
inside Electron, drives pointer and keyboard events, emits the same engine event
frames as the production preload, and asserts visible state plus outgoing IPC
decisions. Only the engine/native boundary is deterministic; the UI itself is
not replaced. An LLM is intentionally unnecessary for these assertions because
model wording would make renderer behavior less reproducible, not more real.

Coverage includes:

- first launch, recent workspaces, the persistent sidebar, and maximized launch;
- session resume/search/rename/archive/delete and new-conversation reset;
- tasks, every mission action, crew cards/actions, and style modes;
- composer send/queue/stop/history, slash and bang commands,
  attachment mentions, model selection, and all permission modes;
- reasoning, streaming Markdown, operations, subagents, background jobs, errors,
  and approval questions;
- inline changed files, expandable diffs, the review drawer, native open, and
  transactional Undo backed by a real temporary Git repository;
- settings, connection test/save/reveal, web search, setup wizard, shortcuts,
  inspector collapse/restore, and narrow-window overlays.

Set `MAGENTRA_UI_CAPTURE` to an absolute PNG path to capture the review-drawer
state during the same test run for visual inspection.
