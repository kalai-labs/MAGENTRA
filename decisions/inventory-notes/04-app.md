# Area: app  (14,011 lines — Electron, typechecked by NOTHING)

The whole area is plain JavaScript outside the compiler. It reaches the engine
only by NDJSON frame STRINGS, so `tsc` protects none of this seam.

## Process boundary

- `preload.js` (150L) — **49** methods, the renderer's entire API. The renderer
  never holds an API key; main does.
  getConfig chooseWorkspace openWorkspace openWorkspaceFile revealWorkspace
  pickContextFiles undoChanges setModel send interrupt restartEngine
  respondPermission testConnection detectLocalServers generateAddon
  saveAddonExport listProfiles saveProfile deleteProfile applyProfile
  getWebSearch setWebSearch getVision setVision getAppInfo updateState
  checkUpdates startUpdate installUpdate onUpdateState openExternal openLogs
  setTitleBarTheme windowControl onFullScreen setZoom getZoom getPathForFile
  onEvent onRestarted onSetupRequired focusTab closeTab openInNewWindow
  onTabOpened onTabFocused onTabClosed onTabCap onRecentWorkspaces
- `main.js` (1,982L) — **36** IPC channels:
  context:pickFiles · connections:detectLocal · addons:generate|saveExport ·
  profiles:list|save|delete|apply · setup:testConnection ·
  app:info|titleBarTheme|openLogs|openExternal · config:get|setModel ·
  workspace:choose|open|openFile|reveal · changes:undo ·
  settings:getVision|setVision|getWebSearch|setWebSearch ·
  tab:focus|close · window:control|open ·
  engine:send|interrupt|restart|permission ·
  updates:state|check|start|install
  Also owns IMAGE_TYPES (mirrored from engine/tools/src/read.ts) and
  TAB_ACCESSORS (must enumerate every per-conversation singleton, or state
  leaks across tabs).

## main/ (6 modules)

- `config.js` (317L) — config.json, DEFAULT_MODEL/BASE_URL, isLocalBaseUrl
  (mirrored), REASONING_EFFORTS (mirrored), VISION_API_KEY_ENV,
  normalizeBaseUrl (strips a pasted `/chat/completions` or `/models`),
  writeJsonAtomic.
- `connection.js` (638L) — TEST: endpoint discovery walking the URL as given,
  a localhost→127.0.0.1 swap, then every known OpenAI-compatible path shape
  (`/v1`, `/v1/openai`, `/inference/v1`, `/openai/v1`, `/api/v1`) for ANY host.
  A 404 on `/models` is DISAMBIGUATED by probing the chat route directly
  (400/422/200 = exists, 401/403 = exists and refused the key, 404/405 = not the
  API). `discoverContextLimit` asks the server what it will actually run the
  model with: vLLM/SGLang max_model_len, Ollama `/api/show`
  (<arch>.context_length), LM Studio `/api/v0/models`
  (loaded_context_length else max_context_length), llama.cpp `/props` (n_ctx).
  Hosted endpoints get no server-shape probes.
- `profiles.js` (127L) — global named profiles in `~/.magentra/profiles.json`,
  **0600**, keys INSIDE. Pure I/O, no Electron, "so the setup wizard and the
  tests can drive it directly". upsert/delete/find/sanitize. Deleting a profile
  clears it from any profile naming it as `visionProfileId` (a dangling pointer
  would fail much later, at connect time). `sanitizeProfile` strips the key at
  the IPC boundary and resolves visionModel to a NAME.
- `updates.js` (352L) — two tiers by install format. LINUX_ARCH renames per
  target (AppImage `x86_64`, deb `amd64`, tar.gz `x64`) because
  electron-builder rewrites `${arch}` — deriving from `process.arch` produced a
  404 for two of three formats. Windows `portable` detected by
  PORTABLE_EXECUTABLE_DIR, never by `process.platform`. Exports installTier and
  assetName deliberately, as the two most worth pinning.
- `changes.js` (102L) — resolveWorkspaceFile (path-escape + symlink guard),
  diffTargetsOnly, reverseApplyDiff, undoWorkspaceDiffs: reverse-applies newest
  first and ROLLS BACK everything it already reversed if one fails, so Undo is
  all-or-nothing.
- `logging.js` (199L) — includes stdin-log redaction (why `set_connection`
  carries the key inside `connection`).

## renderer/modules (21 modules, 7,459L) + index.html (688L)

- `math.js` (492L) — a complete LaTeX→**MathML** renderer written by hand:
  tokenizeLatex, makeReader, readGroup, parseMatrix, parseAtom, parseSequence,
  renderMath. No library, no CDN, nothing the strict CSP must relax.
- `markdown.js` (424L) — own renderer: inline math detection, code blocks,
  tables with alignments, block/inline split.
- `stream.js` (614L) — streaming Markdown with COMMIT POINTS (a block renders
  when complete, so a half-streamed fence never flickers through a partial
  parse), tool rows with tickers and expandable output, agent cards + meter,
  phase banners, turn separators, stream trimming, compacting card, sys
  notes/errors/notices.
- `tabs.js` (1,066L) — concurrent workspaces: createTabState, captureInto,
  applyFrom, runInTab, routeEngineEvent, per-pane composer/queue/permissions/
  jobs/overdrive, applyLayout (tiling 2-4), tab bubbles, pane ctx menu.
  Chrome updaters must no-op for a non-focused tab.
- `landing.js` (1,166L) — the engine-event handler surface: onSessionStarted,
  onSessionRestored, onSessionList, onTurnStarted/Finished, onTextDelta,
  onThinkingDelta, onToolCallStarted/Finished, onAgentSpawned/Finished,
  onCommandOutput, onPermissionRequest (+queue, +per-tab), onQuestionRequest,
  onBackgroundNotification, onEngineGone, session report modal, background jobs.
- `setup.js` (664L) — the connection wizard: presets, local-server detection,
  profile load/save/delete/use, vision options, context-limit application,
  payload build + change detection, failure description.
- `workbench.js` (482L) — inspector (tasks|changes), sidebar workspaces +
  sessions (day-grouped, relative age), inline changes card (compact at 2, then
  "N more"), **review drawer** with per-file tabs and diff line classes, and
  transactional Undo. NOTE: `sessionChanges` is built from engine `file_edited`
  events — it never consults git, so it cannot see untracked or externally
  changed files.
- `session.js` (338L) — model catalog, model/effort pickers, session + context
  meters, boot.
- `state.js` (455L) — UI settings persistence, zoom clamp/adopt, compact-limit
  clamp, safety settings, segmented controls.
- `views.js` (404L) — view switching, menus, full-screen toggle, modal focus
  trap + a11y, screen-reader announce, the live "now" line ticker.
- `events.js` (242L) — parseDiff, session change accounting, credential-error
  detection and banner.
- `overdrive.js` (182L) — engage/disengage with a cinematic, motion-reduced
  respect, confirm dialog.
- `rain.js` (222L) — matrix-rain canvas: glyphs, opacity scalars, resize,
  still-paint when motion is stilled, mount/unmount.
- `addons.js` (316L) — addon cards, export, create-addon wizard, model/profile
  selection for authoring.
- `tasks.js` (147L) — task rail + addon chip.
- `tour.js` (167L) — first-run tour with positioned steps.
- `updates.js` (108L) — update footer states.
- `tokens.js` (48L) — estimateTokens/formatTokens **mirrored** from
  protocol/tokens.ts.
- `util.js` (281L) — scroll management + auto-scroll, toasts, status LED,
  error summarising, context menus.
- `dom.js` (242L) — element references only.

## scripts (4)
`launch.js` (84L, incl. `--smoke`), `bundle-engine.js` (229L, esbuild bundle),
`dist.js` (60L), `afterPack.js` (159L).
