# Area: tooling  (FEATURES.md omits this entirely — added per instruction)

Both are load-bearing parts of MAGENTRA and neither has any test.

## Version tool (`tools/version/`, ~1,600L)

Decides EVERY release and writes EVERY changelog. No runtime dependencies, so it
runs straight after a clone with no build — a broken build must not stop a
release. JavaScript with types in JSDoc, `// @ts-check`, checked by
`tsc -p tools/version`.

- `version.mjs` (149L) — parse, format, legacyBuild, bump, compare,
  largestLevel.
- `commits.mjs` (188L) — parseCommit, checkMessage, isGitGenerated. Enforces
  conventional commits: 11 types (feat→minor; fix/perf/revert/docs/refactor/
  test/build/ci/chore/style→patch), 10 allowed scopes (engine, core, tools,
  providers, protocol, host, app, tui, docs, build), subjectMaxLength 72.
- `plan.mjs` (103L) — makePlan: the next version from the commit range.
- `changelog.mjs` (165L) — renderRelease, prependRelease.
- `sync.mjs` (135L) — syncTargets writes the version into **8** package.json
  files (root, 5 engine packages, app, tui).
- `git.mjs` (174L) — git, repositoryRoot, versionTags, commitsSince, originUrl,
  githubHttpsUrl, hasUncommittedChanges.
- `config.mjs` (134L) — loadConfig, readVersion, writeVersion over
  version.config.json + VERSION. tagPrefix "v", releaseBranch "main".
- `bin/magentra-version.mjs` (511L) — CLI: current, plan, apply, check, commit.
  Also the **commit-msg git hook** (`.githooks/commit-msg`, wired by
  `npm run prepare` via core.hooksPath) and the CI PR-title/commit-range check.

## Prompt Lab (`tools/prompt-lab/`, ~28KB server + 72KB UI)

A local console for every prompt the engine sends — the live editing surface for
the prompt registry. `npm run prompt-lab` → http://127.0.0.1:4319,
`-- --port N --dir <overrides>`.

- Serves `index.html` + a JSON API over the prompt registry in
  `@magentra/protocol`. Routes: `/api/catalog`, `/api/events` (SSE),
  `/api/import`, `/api/reset-all`.
- Editing in the browser writes a plain `.txt` per prompt under the overrides
  dir; the engine RE-READS those live, so a change lands on the next turn with
  no restart.
- Functions: tscBuild, ensureBuilt, newestMtime, systemPreview, catalog,
  loadFindings, markAddressed, setNoteAddressed, setStepDone, stepPasses,
  sourceFiles, toSourceLiteral, locateLiteral, promotable, **promote** (writes
  an override back into the TypeScript source literal), broadcast,
  markSelfWrite/isSelfWrite (so its own writes don't retrigger the watcher),
  startWatching.
- Recorded platform lesson: never invoke the compiler as `npx tsc` — on Windows
  `npx` is `npx.cmd` and `execFile` without a shell cannot spawn it (ENOENT).
  It failed invisibly TWICE: promote reported "typecheck failed" with an empty
  body, and startup printed "BUILD FAILED" with nothing after it while the lab
  served defaults from a stale `dist`.
- `findings.json` (65KB) — a prompt-analysis record. THREE entries justify "no
  change" on the grounds that `addon-check.mjs` guards the behaviour; that
  guard was deleted in the test reset, so those rationales are now void.

## The prompt registry itself (`engine/protocol/src/prompts.ts`, 256L)

definePrompt, promptText, renderPrompt, promptTextIfEnabled, isPromptDisabled,
promptCatalog, writePromptOverride, clearPromptOverride, setPromptDefault,
orphanedPromptFiles, promptsDir, promptFile.

**43 registered prompts** in 7 groups:
  1 · Core system prompt (prompts.ts, 11)
  2 · Conditional system sections
  3 · In-turn reminders (session.ts, 19)
  4 · End-of-turn rungs (finishing.ts, 7)
  5 · Background inference calls
  6 · Subagents (agents.ts, 3)
  7 · Tool descriptions (tool.ts, 1; engine.ts, 1; addons.ts, 1)
Every one is overridable at runtime and editable in prompt-lab. Nothing tests
any of them.

## Other tooling in the tree (not MAGENTRA features, noted for completeness)

- `.claude/skills/bigpicture/` — MAP.md generator + BIG-PICTURE freshness
  check (the hash mechanism the gateway reuses).
- `.claude/skills/bigboycoding/blast-radius.mjs` — importer/symbol/frame seam
  analysis (the gateway's dependency source).
- `benchmarks/` — terminal-bench driver, agent harness, results tooling
  (1,064L of Python) and 6 prompt-benchmark task files.
- `vision_probe.py` (268L) — a standalone vision-endpoint probe.
