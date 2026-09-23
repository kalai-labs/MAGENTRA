# FIX-PLAN — MAGENTRA field-test fixes

Source of every item: the field-test report
[`docs/reports/2026-09-23-magentra-field-test/report.pdf`](docs/reports/2026-09-23-magentra-field-test/report.pdf)
(LaTeX source next to it). The report observed one 56-minute GLM-5.3 build turn in
the desktop app on 2026-09-23 and lists every finding with an ID (U-, S-, E-, V-,
M-, L-, R-). This plan turns those findings into **15 tasks, T00–T14. Each task is
done in its own Claude session, one after the other, in the order below.**

The owner is Muhammet Ali Öztürk. "Ask the owner" means: stop and ask with the
AskUserQuestion tool, and wait for the answer. Never assume it.

---

## 0. Status board — update this at the end of every session

| Task | Findings | Title | Status | Session notes |
|---|---|---|---|---|
| T00 | — | Preparation: baseline and skill doc | done | 2026-09-23. Commit: none — the owner chose not to commit; the changes are in the working tree. Owner decision: leave the 18 stale gateway records alone, only keep the list below (later tasks do not re-record them). Baseline recorded under this table. `bigboycoding` SKILL.md: rewrote the verification section (build first, the kind → command table, count before/after, revert-verify, gateway first + freshness, approved artifacts, smoke and CI). Replaced the deleted `*-check.mjs` "spec for the rebuild" with a coverage map checked against `tests/features/` and a 4-row backlog of what nothing guards yet (TUI cell layout, no-reflow, folder trust, compaction sizing). Also fixed the other false test-setup lines (intro "no test suite", "`dist/` is committed", "no test catches a system-prompt regression"). **Args bug: real.** Claude Code replaced the literal `$ARGUMENTS` in the addon-check row with the caller's args. I removed the token and added a gotcha. Re-invoked with a probe string: it now appears only at the end, as `ARGUMENTS: …`. No product code or tests changed. After the edit, the same commands gave the same counts (`npm test` 505 passed / 0 failed / 85 withheld, `test:ui` 51 / 0, typecheck clean). Left for T14: the "system map" section (`docs/big-picture/` does not exist). The file counts (75/24/34) are still correct. **Files changed:** `.claude/skills/bigboycoding/SKILL.md`, `FIX-PLAN.md`. |
| T01 | U-01, U-09, R-1 | Reasoning stream does not freeze the renderer | done | 2026-09-23. Commit: none — the owner chose not to commit; the changes are in the working tree. **Gateway:** new record `long-streams-never-stall-the-window` (ui, deferred by rule), 6 tests; description `a62978d8…` approved by the owner in chat, still `draft` on disk (the draft→ready click is the owner's). **Owner decisions:** approve the record/invariant/checklist as written; a LIVE reasoning block shows its tail, all text when it ends; the records this change makes stale go on the stale list, not reconciled. **Cause, measured on the real app through the real IPC:** with the reasoning block OPEN, 2,000 deltas took 6.7 s at the start and 109.9 s after 10,000 (quadratic), and a task update sent after 12,000 reached the rail 301 s late; closed it was linear (~0.25 ms/delta) but grew one DOM node per delta. An answer that is one long block with no committable blank line was quadratic too (3.2 s → 28.7 s per 2,000): a forced layout per delta, plus `markdownCommitPoint` re-counting the whole message once per blank line inside an open fence. **Fix (renderer only):** reasoning deltas queue on their own block and reach the page once per animation frame (a 250 ms timer covers a window that draws no frames); a live block shows its last ~8,000 characters behind a "N earlier characters are held back" line, and all of it is written into the block when it ends; the live edge is measured once per frame, not per delta (`followLiveEdge`); the commit-point scan is fed each delta (incremental, same verdicts); the answer's live tail is appended, not rewritten; the now-line is set once per stretch ("thinking · 45s", "responding · 12s"), never a token, never a per-delta timer reset. **After:** 500 reasoning deltas cost 5–8 ms flat (block open); a task update after 20 s at 250 deltas/s is handled 5–13 ms after it is sent (was 12.8 s); the long code answer's late/early ratio is 0.75 (was 4.9); 36,000 answer deltas in one 171 KB block with no blank line: 119 → 169 ms per 6,000 (was 192 → 1,271 before the append step). **Field log replayed by hand once** (132,035 frames at 20×, all 35 reasoning blocks opened): 335/335 task/tool/turn/question frames handled in order, lag p50 4 ms / p95 28 ms / max 40 ms, live body ≤ 2 DOM nodes. **Not done:** a live run with a real reasoning model, watched on screen (the plan's manual check) — the replay above stands in for it; the owner should try one. **Tests:** `tests/features/long-streams-never-stall-the-window.test.ts` (6, `ui`). Revert-verified: with the fix stashed, tests 1–4 fail with the field symptoms (4.7×, 12.8 s late, "thinking · fjord · 0s", 4.9×); 5–6 are guards and pass on both. Mutation-checked: tail never trimmed → test 1; held-back text lost → tests 1+5; one global buffer → test 5; token on the now-line → test 3; per-delta scroll → test 4 (4.4×); whole-message commit scan → test 4 (3.1×). NOT caught by a test: rewriting the whole live tail per delta (it only shows at ~171 KB; covered by measurement). **Gates:** build exit 0; `npm test` 596 registered, 504 passed, 1 failed, 91 withheld (85 + the 6 new ui) — the red is `import-graph · an-edited-file-is-re-extracted…`, a pre-existing flake (1 of 10 runs with AND without this change: it asserts an mtime moved when two writes can land in one tick); `npm run test:ui` 57 passed, 0 failed; `typecheck:tests` clean; `smoke` exit 0. **System-wide:** engine and protocol unchanged; the TUI needs nothing (it paints at ~30 fps and never draws reasoning, `useEngine.ts:15-22, 462-468`); per-tab: pending text lives on its element, so a background tab's reasoning lands in its own pane (test 5, tiled + a real focus change); session replay still shows the whole reasoning (test 6); a reload drops only what the page held; no IPC batching in main — not needed at the measured cost. **Found, not fixed:** (1) `onToolOutputDelta` still does a forced layout per delta (same class of bug, for noisy commands); (2) the log's redaction depth cap turns every `question_request` option into "[depth capped]" and 107 lines are cut invalid (for T05). **Files changed:** `app/renderer/modules/landing.js`, `app/renderer/modules/stream.js`, `app/renderer/modules/util.js`, `app/renderer/styles.css`, `tests/features/long-streams-never-stall-the-window.test.ts` (new), `tests/gateway/features/long-streams-never-stall-the-window.json` (new), `tests/gateway/descriptions/a62978d8-27b4-42a7-b737-0bbeac0ab5a0.json` (new), `FEATURES.md`, `FIX-PLAN.md`. |
| T02 | U-02 | Renderer watchdog and recovery | todo | |
| T03 | S-01, S-02 | Process-kill guard and the guard message | todo | |
| T04 | M-06, R-3 | Progress comments during long work | todo | |
| T05 | L-01…L-04 | Session log: tokens, valid JSON, size, per workspace | todo | |
| T06 | V-01, V-05, R-4 | Verify the result the way the user uses it | todo | |
| T07 | V-02, V-03, V-04 | Honest "works" claims and a real self-check | todo | |
| T08 | U-03, U-04, U-05, R-2 | Engine timestamps for tasks and timers | todo | |
| T09 | U-06, U-07, U-08, U-09 | UI: reasoning vs progress, sessions, retries, small defects | todo | |
| T10 | U-10 | Output tokens: show the reasoning part | todo | |
| T11 | M-01, M-02, M-04, M-05 | Less silent drafting, short Edit anchors | todo | |
| T12 | E-02, E-03 | Tool frame pairing and background-job waits | todo | |
| T13 | E-05, E-04, E-06 | Edit error hint, shell-edit tracking, stats saved often | todo | |
| T14 | — | Generate the new big picture (LAST) | todo | |

### Baseline (T00, 2026-09-23)

Compare every later run with these numbers. Branch `fix/general` at `028231a`, Node
v24.14.0, Windows 11, engine freshly built.

| Command | Registered | Run | Passed | Failed | Withheld | Wall |
|---|---|---|---|---|---|---|
| `npm run build` | — | — | exit 0 | — | — | 1 s (all 6 projects up to date) |
| `npm test` | 590 | 505 | 505 | 0 | 85 (51 ui, 26 llm, 8 artifact) | 124 s |
| `npm run test:ui` | 590 | 51 | 51 | 0 | 539 (not ui) | 159 s |
| `npm run typecheck:tests` | — | — | exit 0, no errors | — | — | 3 s |

- **Reds in the test commands before this plan: none.** The known flake
  (`tty-dispatch · no-tty-hands-off-detached…`) passed in this run.
- Not run in T00: `test:llm`, `test:windows`, `test:mac`, `test:artifacts`.
- **Gateway freshness is already red: 18 of 166 records are stale.** `npm test`
  does not check this, but the gateway gate blocks a whole run on any stale record.
  Nobody reconciled them, because reconciling is a human review. **Owner decision
  (T00): leave them alone and keep this list.** The drifted files:
  - `app/main.js` → 7 records: `a-connection-change-re-points-the-live-session`,
    `boots`, `engine-lifecycle`, `full-screen-can-always-be-left`,
    `mirror-image-types`, `permission-prompt`,
    `saving-a-connection-clears-the-stale-pin-in-both-layers`;
  - `tools/prompt-lab/server.mjs` → the 5 `promptlab-*` records;
  - `app/package.json`, `app/scripts/dist.js` → `mac-artifact`, `windows-artifact`;
  - `app/scripts/bundle-engine.js` → `mac-artifact`, `no-node-modules-at-runtime`;
  - `.github/workflows/release.yml` → `retraction`;
  - `engine/tools/src/worktree.ts` → `tool-enterworktree`, `tool-exitworktree`.
  - **Added by T01 (owner decision: list them, do not reconcile):** `app/renderer/modules/stream.js`
    → `streaming-markdown`; `stream.js` + `landing.js` → `markdown-before-a-question-card`;
    `landing.js` + `stream.js` + `util.js` → `long-streams-never-stall-the-window` (new in T01).
    `permission-prompt` now also drifts in `landing.js`. 21 of 167 records are stale after T01.
- Inventory: 126 records `covered`, 2 `partial`, 38 `untested`.
- **Second known flake (found in T01):** `import-graph · an-edited-file-is-re-extracted-while-an-untouched-entry-is-reused`
  fails about 1 run in 10, with or without any change: it asserts that an mtime moved, and two
  writes can land in one clock tick. Do not "fix" it inside another task.
- There is a repo-root `.env` (44 bytes; I did not read it). See rule 1.6.

Status values: `todo` → `in progress` → `done` (or `blocked: <reason>`). In "Session
notes", write: the commit (if any), the tests added or changed, the owner decisions,
anything left open, and **which files you changed** (T14 needs this list — see rule 13).

---

## 1. Standing rules — they apply to EVERY task

Read these before you start. They override anything a skill or older document says.

### 1.1 Understand before you change

1. **Use the `bigboycoding` skill** (invoke it with the Skill tool) before the first
   edit. For every file you plan to edit, run
   `node .claude/skills/bigboycoding/blast-radius.mjs <file>`. For every engine frame
   you touch, run `node .claude/skills/bigboycoding/blast-radius.mjs --frame <type>`.
   Read the fan-in files, not only the target. `app/` is plain JavaScript and no compiler
   checks it: engine and UI are joined only by frame strings.
   - **Known staleness in that skill:** its "Verification gates — there is exactly ONE
     left" section is out of date. A real test suite exists now (`tests/`, see 1.3). T00
     fixes the text; until then, ignore that section and follow this plan.
     **Fixed in T00 (2026-09-23):** the section now describes the real suite. If it
     ever disagrees with this plan, this plan wins.
2. **Understand the big picture.** Read `CONTEXT.md` (domain words), `tests/README.md`
   (test rules), `decisions/0001`, `0004`, `0005`, `0007`, `0009`–`0015`, and the report
   sections for your findings. `docs/big-picture/` does not exist now (it was deleted in
   commit `e2bc213`), so `bigpicture.mjs check` exits 2. That is expected until T14. Do not
   try to repair it in another task.
3. **Diagnose by reading code and measuring, not by guessing.** In your report, keep
   proven facts apart from hypotheses. The report's E-01 was wrong at first because only
   part of the evidence was compared. Compare the whole thing.
4. **Never remove a feature that you are asked to fix.** A bug report means "repair it",
   never "delete it". Word status reports carefully.

### 1.2 Work system-wide — MAGENTRA is more than one window

Every fix must work in all these places. Check each one and write in your notes how:

- **Engine** (`engine/*`): it serves both frontends over NDJSON. A frame or behaviour
  change reaches the desktop app AND the TUI.
- **Desktop app** (`app/`):
  - one window with **several tabs / workspaces at once**, each with its own engine
    process (`tabs.js`, `dispatchTabId`, `focusedTabId`, per-tab state swap);
  - the **tiled layout**, where each pane has its own stream;
  - **background tabs** that get frames while another tab is focused;
  - more than one window;
  - a renderer reload (the Home button and closing the last tab both call
    `window.location.reload()`) and session resume (`resume_session` → `session_restored`).
- **TUI** (`tui/`): it has its own copy of the protocol types in `tui/src/protocol.ts`,
  checked by `tests/features/tui-protocol-parity.test.ts`. It never shows reasoning text
  (`tui/src/engine/useEngine.ts:9`), but it shows tokens, tasks, retries and sessions.
- **Packaged app vs dev:** `npm run app` does NOT compile the engine. After an engine
  change, run `npm run build` before you run the app or any test (tests import
  `engine/*/dist/`).
- **Windows and macOS:** see the Windows traps in 1.6.

### 1.3 Tests are the gate — real tests only

5. **The gateway comes first** (decisions/0001, 0005). A new feature, a change to one, or a
   bug fix is entered in the inventory first:
   - feature records: `tests/gateway/features/<feature-id>.json` (entryFiles, invariant,
     kinds, test ids, freshness hashes);
   - descriptions: `tests/gateway/descriptions/*.json` (draft → approved);
   - the gateway UI: `npm run gateway` → http://127.0.0.1:4320.

   Write or update the record and the description, then **ask the owner to approve the
   description and invariant before you write the test**. If you edit a record's
   `entryFiles`, the record becomes stale and the gate blocks every run. Re-record its
   freshness the way decisions/0005 says.
6. **Never write a scaffold, mock-up or placeholder test.** Rules 1–7 in `tests/README.md`
   are not negotiable: no skip, no soft assert, the invariant is copied word for word from
   the record, every test has a real `whyItExists`, and there is one file per feature
   (`tests/features/<feature-id>.test.ts`). The only allowed double is the scripted
   provider (`FakeProvider` / `lib/scriptedEngine.ts` / `lib/engineHarness.ts`). Nothing
   else is mocked: real files, real processes, the real built engine, and the real
   Electron app through `tests/lib/appHarness.cjs`.
7. **Put each test in the right command.** The test's kind and subject decide where it
   runs:

   | The test is about | Kind / selector | Command |
   |---|---|---|
   | the desktop UI (launches the real app) | `ui` kind | `npm run test:ui` |
   | a real model on a real connection | `llm` kind | `npm run test:llm` |
   | something only true on Windows | Windows subject | `npm run test:windows` |
   | something only true on macOS | macOS subject | `npm run test:mac` |
   | everything else (pure, fs, proc, net) | those kinds | `npm test` |

   Prefer to **extend the existing test file** of the feature. Make a new file only for a
   new feature record.
8. **Revert-verify every regression test.** Put the buggy code back for a moment, rebuild,
   and see the test fail with the user's real symptom. Then restore the fix, rebuild, and
   see it pass. Say in your notes that you did this. A timing test must use ratios or
   event order, not wall-clock thresholds that pass on a slow machine and fail on a fast
   one.
9. **Do not break what works.**
   - Before you change anything: `npm run build`, then `npm test` and the slices your task
     touches (`test:ui`, etc.). Write down the counts (registered / run / passed / failed).
   - After the change: run the same commands again and compare. A new red must be
     explained.
   - To confirm a red is yours: `git stash push -- <paths>`, re-run, `git stash pop`.
   - `npm run typecheck:tests` must stay clean.

### 1.4 Prompts need the owner's approval — always

10. **If a fix changes model-facing wording, ask the owner first.** That includes the
    system prompt (`engine/core/src/agent/prompts.ts`), a turn reminder
    (`engine/core/src/runtime/session.ts`, e.g. `PLAN_FIRST_REMINDER`), a finishing-ladder
    prompt (`engine/core/src/runtime/finishing.ts`, e.g. `SELF_VERIFY`), or a tool
    description or schema (`engine/tools/src/*.ts`, `.describe(...)`).
    - Show the exact **before** and **after** text, say why, and wait for approval. Ask
      again for every later change to the wording.
    - The pinned snapshots (`tests/approved/system-prompt-is-pinned/`,
      `tests/approved/tool-wire-contract-is-pinned/`) will then fail. **Do not run
      `npm run approve`. The owner runs it** and reviews the diff (decisions/0015). Tell
      the owner which snapshot changed and why.
11. Tool **error messages** (for example the Edit "not found" text) are not pinned. Still,
    show the new wording in your notes.

### 1.5 End of session

12. Ask the owner before you commit. Commit on a branch with a conventional message
    (`npm run commit` asks the questions, and the hook checks the message; see
    CONTRIBUTING.md). Never push unless the owner asks.
13. Update the status board (section 0): status, tests, decisions, open points, and the
    **list of files you changed**. T14 uses that list to rebuild the big picture.

### 1.6 Known traps on this machine (Windows 11)

- `execFile("npx")` fails with ENOENT. Spawn `cmd.exe /c` or use the `.cmd` path.
- Line endings are mixed per file, and `autocrlf` changes raw bytes after a pull. Never
  compare raw-byte hashes across a checkout. Python file I/O needs `encoding="utf-8"`.
- The Electron MAIN process has no usable stdin (the UI harness uses a loopback socket).
- The CI runner's TEMP is an 8.3 short path (`RUNNER~1`).
- A repo `.env` can hide key-dependent tests.
- Known flaky test: `tty-dispatch · no-tty-hands-off-detached…` (EPERM in teardown).
  Do not "fix" it by accident inside another task, and do not let it mask your result.

---

## 2. The tasks

Each task says: the problem, where the code is (file:line as of 2026-09-23, so verify),
what to change, what must work system-wide, which owner decisions to ask, the tests, and
when it is done. The code locations were mapped by reading the source. Anything marked
**(unconfirmed)** must be checked first.

---

### T00 — Preparation: baseline and skill doc (small)

**Why:** every later session uses the `bigboycoding` skill, and its text says there is
no test suite. That is false now and will mislead the fixers.

**Do:**
1. Run `npm run build`, then `npm test`, `npm run test:ui` and `npm run typecheck:tests`.
   Record the counts in the status board as the **baseline** (and any reds that exist
   before this plan).
2. Update `.claude/skills/bigboycoding/SKILL.md`:
   - Replace the "Verification gates — there is exactly ONE left" section with the real
     gates: `npm run build`, the test commands table (rule 7), revert-verify, and the
     gateway-first rule.
   - Remove the list of deleted `*-check.mjs` files as "the spec for the rebuild". The
     suite exists now. Keep the invariants that are still not covered, and mark them as a
     backlog.
   - The memory notes say that invoking the skill puts the caller's `args` into the middle
     of its prose table. Check this and fix it if it is true.
   - Do not touch `bigpicture` here (T14 does it).
3. Do not change product code in T00.

**Done when:** the baseline is recorded, and the skill text matches the real test setup.

---

### T01 — The reasoning stream must not freeze the renderer (Critical · R-1, U-01, U-09)

**Problem.** The UI showed "reasoning" for 25 minutes while the engine wrote files. Then
all steps seemed to finish in 0 s. The screen fell up to 24.6 min behind, and the
renderer used ~1.5 CPU cores. The owner calls this the most critical bug.

**Cause (confirmed in code):**
- `app/renderer/modules/landing.js:497-517` `onThinkingDelta` runs once per token:
  - it appends one text node (≈113 000 nodes in one run, line 516);
  - it wraps each append in `withAutoScroll` (`util.js:37-43`). `isNearBottom`
    (`util.js:23-27`) reads `scrollHeight`, which forces a full layout of a transcript
    that keeps growing. The cost grows with the square of the length;
  - it calls `setNowActivity("thinking", lastLine)` (lines 498-501) with the raw token. That
    is why the status line read "thinking · Enemy · 0s": `setNowActivity`
    (`views.js:330-335`) also resets `nowActivityStart` to now on every call, so the
    timer shows 0s (U-09).
- `onTextDelta` (`landing.js:459-492`) also renders once per delta, through
  `commitStreamedMarkdown` (`stream.js:44-60`), with no batching.
- Main forwards one `webContents.send("engine:event")` per engine stdout line
  (`app/main.js:521-540`, `sendToRenderer` at `:219-222`). The renderer gets one
  `ipcRenderer.on` callback per frame (`preload.js:104-108`) and handles frames in order,
  so every later frame (tasks, tool rows, retries, turn end) waits behind the reasoning
  backlog.
- The reasoning block is a `<details class="msg-thinking">` with **no `open` attribute**,
  so it is collapsed by default. No CSS forces it open (`styles.css:817-819`). The
  owner's screenshot shows it expanded, so it was probably opened by hand. **Measure the
  cost in both states.** Even collapsed, 113k text nodes and a layout read per token are
  a cost.

**Change (the direction — the design is yours, within these limits):**
- Buffer deltas in the renderer and write them to the DOM **once per animation frame**
  (`requestAnimationFrame`), as one text node or one string append. Measure "near bottom"
  once per frame, not per token.
- Apply the same batching to `onTextDelta` / `commitStreamedMarkdown`. Keep the existing
  streaming-markdown guarantees (a half-streamed fence, table or formula stays plain).
  `tests/features/streaming-markdown.test.ts` must stay green.
- The now-line: do not pass raw tokens. Do not reset the activity timer per delta. Show
  a stable label, e.g. "thinking · 8m 12s" (optionally with the token count).
- Put a limit on the live reasoning DOM, e.g. keep the tail visible and the full text in
  memory until the block is opened. Session replay (`landing.js:184-195`,
  `onSessionRestored` at `:174`) must still show the full reasoning.
- Frame ORDER must be kept: a `tool_call_started` that arrives after deltas must appear
  after them, and `finalizeThinkingEl()` (`stream.js:88-92`, called from
  `onToolCallStarted` / `onTextDelta`) must flush the buffer first.
- Decide whether main should also batch IPC (for example several frames per send).
  Keep the order and the per-tab routing (`tabId` is added at `main.js:538`). The
  renderer fix alone may be enough, so measure first.

**System-wide:**
- **Per-tab buffers.** Each tab and tiled pane has its own stream and its own
  `currentThinkingEl` (swapped in `tabs.js`). A delta for a background tab must flush
  into that tab's stream, never into the focused one.
- Switching tabs while deltas are buffered must not lose or misplace text.
- Reload and resume paths must still work.
- The TUI does not render reasoning. Check that its `text_delta` path
  (`tui/src/engine/useEngine.ts`) has no per-token cost of the same kind, and write the
  result in your notes. Change it only if you measure a real problem.

**Tests (kind `ui` → `npm run test:ui`; revert-verify against the current code):**
- A new or extended feature record for the reasoning-stream rendering (there is no test
  for `onThinkingDelta` today). Gateway first, then ask the owner to approve.
- Drive frames through the **real IPC channel**: `evaluateInMain` →
  `win.webContents.send("engine:event", {...frame, tabId})`, not by calling the renderer
  function directly. Send tens of thousands of `thinking_delta` frames at a realistic
  rate, then a `task_list_updated`.
- Assert: the task rail shows the new state within a bound measured in frames/ticks after
  it is sent. The processing cost of the last 10k deltas is not much larger than that of
  the first 10k (a ratio, not milliseconds). The number of DOM nodes stays bounded. The
  status line never contains a raw token.
- A two-tab case: deltas for a background tab never enter the focused tab's stream.
- The current code must fail these tests (the O(n²) ratio and the stale rail).
- Do not commit the 12.8 MB field log. Generate the stream inside the test from a seed.
  The real log (`C:\Users\alini\phdworks\test\.magentra\logs\desktop-20260923-180141.log`)
  can be used by hand, once, to check the result.

**Done when:** the replay test passes, all streaming tests stay green, and a manual run
with a long reasoning model stays live (the Tasks panel moves while reasoning streams).
Record the before/after numbers in the notes.

---

### T02 — Renderer watchdog and recovery (Critical · U-02)

**Problem.** About 19:00 the whole window went black (renderer at 946 MB, ~135 % CPU).
Nothing detected it. The user missed the final answer, which held the game rules.

**Where:**
- `app/main.js:1002-1033` `render-process-gone`: it logs, and has a Windows sandbox
  rescue only before the first paint.
- `:1034-1036` `unresponsive`: it only logs. There is no `responsive` handler.
- There is no heartbeat or watchdog anywhere.
- The re-sync path that exists: `resume_session` → `session_restored` → `onSessionRestored`
  (`landing.js:174-206`). It is used only when the user clicks a session.

**Change:**
- A renderer heartbeat (for example every 1 s over the preload bridge). Main logs a
  `renderer-stalled` event when the heartbeats stop for N s, and `renderer-recovered` when
  they start again. Also add a `responsive` handler.
- A recovery path for a stalled or crashed renderer after the first paint. **Ask the owner
  about the UX**: automatic reload, or a native dialog with "Reload window / Wait". The
  engine keeps running during a reload.
- After a reload during a turn, the window must show the running turn again. Find out
  whether `session_restored` plus the live frames can do this today (the transcript is
  written during the turn), and fix the gap. This includes the tasks, tool rows and the
  now-line of a turn that is still running.

**System-wide:**
- Several tabs share one renderer: one reload must bring back every tab and its engine
  link.
- Several windows: each window has its own watchdog.
- Tiled layout.
- The TUI is not affected, but the engine must not change behaviour when a frontend
  reconnects.

**Tests (`ui` → `npm run test:ui`):**
- Block the renderer on purpose (a busy loop through `evaluate`), and assert the stall
  and recovery log events.
- Reload during a scripted running turn, and assert that the tabs and the turn state come
  back.
- The watchdog must not fire on a normal slow frame. There is a clean-boot check in
  `windows-artifact.test.ts:384-388` that the log has no `render-process-gone`. Keep it
  green.

**Done when:** a stall is logged and recoverable, and a reload during a turn gets the
state back in single, tabbed and tiled layouts.

---

### T03 — Process-kill guard and the deletion-guard message (Critical · S-01, S-02)

**Problem.** In overdrive, the agent ran `taskkill //F //IM python.exe //FI "WINDOWTITLE eq *"`
with no prompt. That stops **every** Python process on the machine. Four seconds later it
used the correct tool (`TaskStop`). Separately, the start-up message says "deletion guard
on — destructive calls always ask", but overdrive switches the guard off by design.

**Facts (confirmed):**
- The deletion classifier is in `engine/tools/src/bash.ts`: `DELETION_SINGLE_WORDS`
  (`:16-27`), `DELETION_PHRASES` (`:31-44`), and the special cases (`:55-82`). It is
  combined in `bashDeletionSubject` (`:92-100`), wired as `bashTool.deletionSubject`
  (`:283`), with `bashDeletionScope` at `:194-224`.
- **No process-kill command is classified**: `taskkill /IM`, `pkill`, `killall`,
  `Stop-Process -Name`, `kill -9 -1`, `Get-Process … | Stop-Process`, `wmic process …
  delete`. They get the stance default "allow" (`permissions.ts:378-380`).
- Overdrive computes no deletion subject at all (`permissions.ts:248-249`,
  `this.overdrive ? undefined : …`). `deletion-guard.test.ts` asserts this ("turning the
  guard off or overdrive on computes no deletion subject at all"). **That behaviour is
  intended.**
- The message text is at `engine/core/src/runtime/engine.ts:731-739`.

**Owner decision — ask BEFORE coding.** Present the options with a recommendation:
- (A) Kills **by process name** always ask, in both stances and also in overdrive (a new
  guard beside the deletion guard, so the overdrive contract of the deletion guard is not
  changed).
- (B) Kills by name are refused with a message that names `TaskStop` and the job id or
  pid, and a kill of a pid that the session started is allowed.
- (C) They ask outside overdrive and are allowed in overdrive, like deletions.

  Also ask whether `Bash`'s tool description should tell the model to prefer `TaskStop`.
  That is a tool-description change, so rule 10 applies.

**Change (after the decision):**
- A pure classifier for kill-by-name and kill-all forms, covering Git-Bash `//F //IM`,
  cmd `/F /IM`, PowerShell and POSIX forms. Wire it into `PermissionEngine` in the
  resolution order written at `permissions.ts:102-117`.
- Correct the guard message (S-02) so it says what really happens in overdrive. This is
  user-facing text in the engine, and both frontends show it. Show the wording to the
  owner.

**System-wide:**
- The desktop permission prompt (`permission-prompt` feature) and the TUI permission
  prompt must both show the new question, if the decision is (A) or (C).
- Both stances (normal / overdrive) and the always-allow grants: a shape grant must never
  cover a kill-by-name, in the same way as `command-shape-always-allow.test.ts` does for
  deletions.

**Tests (`npm test`: `pure` for the classifier table, `proc` with the real engine and a
real shell, following the pattern of the last test in `deletion-guard.test.ts`):**
- The classifier flags the kill forms and passes over safe look-alikes (`skill`,
  `killed.txt`, `grep kill`).
- In the chosen stance the real session asks, refuses or allows as decided.
- `deletion-guard.test.ts`, `deletion-scope-split.test.ts`, `allow-all-stance.test.ts`,
  `command-shape-always-allow.test.ts` and `permission-stances.test.ts` stay green without
  edits, unless the owner changes their invariant.

**Done when:** the field-test command cannot run silently, and the message is true.

---

### T04 — Progress comments during long work (High · M-06, R-3)

**Problem.** From 18:06:29 to 18:30:12 (24 min) the user saw no text at all: the model
only reasoned. After 18:30 the model did comment before most steps (2 906 text frames),
but T01's backlog hid those comments. The owner wants MAGENTRA to feel alive, like
Claude Code: short comments while it reads and works.

**Where:**
- `engine/core/src/agent/prompts.ts:31-40` `SECTION_COMMUNICATION` already says: "Before
  the first tool call of a task, say in one sentence what you are about to do…" The model
  did not do this during planning.
- `PLAN_FIRST_REMINDER` is at `session.ts:324-332`.
- No mechanism reacts to a long reasoning run with no text or tool call (confirmed: the
  wrap-up nudge at `session.ts:1723-1738` and the stall detector at `:1786-1796` both need
  tool calls).

**Change — propose options to the owner first:**
- **UI (no prompt change):** during reasoning, show live progress in the now-line and the
  reasoning summary, e.g. "reasoning · 12.4k tokens · 8m". The user then sees that work is
  going on. This builds on T01.
- **Engine:** when a model call returns with a very long reasoning run and no user text,
  add a reminder before the next call (not mid-stream) that asks for a one-sentence status.
  A per-call reasoning budget is another option, but check how effort and output limits
  work with the provider first (`reasoning-effort-clamp`).
- **Prompt:** make the rule concrete, e.g. "During planning, tell the user in one sentence
  what you are planning before you think at length." Rule 10 applies: show before/after
  and get approval.

**System-wide:**
- The reminder and the budget are engine-level, so they reach both frontends. Check how
  they interact with the finishing ladder (`finishing.ts`) and with child agents
  (`this.opts.child`).
- The UI progress display must work per tab and in tiled panes. The TUI's LiveLine should
  show the same progress. Check `tui/src/components/LiveLine.tsx`.

**Tests:**
- An engine reminder → `npm test`, with the scripted provider returning a long reasoning
  block and no text. Assert that the reminder is attached to the next request, once.
- The UI progress label → `npm run test:ui`.
- A behavioural test with a real model → `npm run test:llm`, if the owner wants one:
  "a multi-step request produces user-visible text before the first tool call".
- Prompt change → the approval snapshots fail on purpose, and the owner runs
  `npm run approve`.

**Done when:** a long planning phase shows the user that work goes on, and the behaviour
the owner approved is tested.

---

### T05 — Session log: tokens, valid JSON, size, per workspace (High · L-01…L-04)

**Where:** `app/main/logging.js`.
- `SENSITIVE_KEY_RE = /key|token|secret/i` (`:24`), used in `redact` (`:57-66`, depth cap
  4) — it hides every `*Tokens` field.
- `logEvent` (`:105-116`) cuts a line at 2048 characters **after** `JSON.stringify`, so the
  JSON breaks.
- Every engine frame is logged at `app/main.js:537`.
- **No test covers `logging.js`** today; only `tests/lib/appDriver.ts` reads the log
  indirectly.

**Change:**
- L-01: redact by an exact list of secret field names, or by the value form (for example
  an API-key pattern), never by a part of a name. The existing secret masking in
  `@magentra/core` (`secret-handling.test.ts`) is a different path. Do not merge them
  without a reason.
- L-02: shorten long string fields inside the object before `JSON.stringify`, so every
  line stays valid JSON, and mark which fields were shortened.
- L-03: combine `thinking_delta` / `text_delta` frames in the log (for example one line per
  block or per second) and keep counts.
- L-04: `tool_call_finished` gets a duration (main can compute it from the started frame);
  make the time zone clear (UTC in the file name, or an offset in the lines); and stop the
  start-up `engine-write-dropped` noise, or log it at a clearly harmless level.
- **Check the multi-workspace behaviour.** There is one `currentLogFile`, set by
  `setLogWorkspace` for the focused tab (`main.js:170, 1815`). Frames from an engine in
  another tab are probably written to the focused workspace's log. **(Unconfirmed — prove
  it first.)** If it is true, log per tab/workspace, or at least write `tabId` and the
  workspace in each line.

**Tests (`npm test`; `logging.js` needs no Electron, so an `fs` kind test can `require`
it; add `ui` only for the multi-tab log routing):**
- `*Tokens` values survive, and secrets do not.
- Every line of a log with a 50 KB tool input parses as JSON.
- Deltas are coalesced.
- Durations are present.
- The multi-workspace routing is correct.
- Revert-verify each one.

**Done when:** the field-test log could be read without the transcript.

---

### T06 — Verify the result the way the user uses it (High · V-01, V-05, R-4)

**Problem.** The agent said "complete, verified". Its bot tested only the HTTP API. It
never ran the browser client. The owner then found defects in minutes: the mouse aim did
not work, the player was not visible, and there was no hit or kill feedback. Also, the
"STAIRS OPEN" message was never shown, and the stairs looked the same when locked.

**Where:**
- `engine/core/src/runtime/finishing.ts`: the runtime-evidence rung. `VISION_ON`
  (`:128-136`) already tells the model to "capture a screenshot of the running app and
  Read it" when vision is on. Vision WAS on in this session, and the agent never did it.
  **First find out why:** read the transcript
  `C:\Users\alini\phdworks\test\.magentra\sessions\s_mue8gg2u_5aed60.jsonl` and see
  whether the rung fired, what it said, and what the model did.
  (`tests/features/runtime-evidence-floor.test.ts` covers the rung.)
- Read (`engine/tools/src/read.ts:92-131`) sends images to the vision model. **There is no
  screenshot or headless-browser tool** in the engine. The model must make a screenshot by
  itself.

**Change — propose to the owner first:**
- Make the rung harder to skip for a web or visual deliverable. For example: the turn
  changed HTML/JS/CSS or started a server with a page → require evidence from a browser
  (a screenshot that was Read, or a headless-browser run), not only HTTP 200.
- A decision for the owner: add a built-in way to capture a page? For example a tool that
  opens a URL in a headless Electron/Chromium window, sends input, and returns a screenshot
  path. That is a new feature: gateway record, owner approval, tests. Or keep it
  instruction-only.
- Any prompt or rung wording → rule 10.

**System-wide:** rungs run in the engine, so both frontends are affected. Consider child
agents, overdrive and normal mode, and a vision connection that is on or off
(`VISION_ON` vs off).

**Tests:**
- The rung firing rules → `npm test` (scripted provider).
- A real-model behaviour check → `npm run test:llm`.
- A new capture tool (if approved): its own `proc`/`ui` tests, run with the real Electron.
- Approval snapshots → the owner runs `npm run approve`.

**Done when:** a web deliverable cannot be declared verified on API checks alone, per the
owner's decision.

---

### T07 — Honest "works" claims and a real self-check (High/Medium · V-02, V-03, V-04)

**Problem.**
- The agent claimed "combat confirmed working" from one kill, while an earlier symptom
  ("enemies never damage the player") was never checked.
- The overdrive self-check took 11 s and said "verified — nothing left to do". It did not
  see the stray game sessions that the agent itself mentioned in its final answer ("two
  stray test sessions may still be registered").
- A known bug class (`.Value` vs `.value`) was not searched for across all files.

**Where:**
- `engine/core/src/runtime/finishing.ts:207-256`: `SELF_VERIFY` with
  `SELF_VERIFY_CLOSING_CODE` / `_PLAIN`.
- It fires from `session.ts:1688-1717`, only in overdrive, at most once per turn.
- It sees the full message history. Its answer is streamed silently, and `isSelfVerifyDone`
  is at `session.ts:222-248`.
- Tests: `self-verify-rung.test.ts` (llm kind) and `self-check-sharpening.test.ts`.

**Change (all prompt text → rule 10, owner approval):**
- The self-check must list the symptoms the agent reported during the turn, and confirm
  that each one was re-tested.
- It must treat hedges in the final answer ("may still", "not verified", "unverified") as
  open work, or require an explicit note to the user.
- Consider an engine-side helper so the model does not have to find the hedges itself:
  pass them to the self-check as a list.
- After a fix whose cause the agent names as a pattern, remind it to search for that
  pattern in all files.

**System-wide:** overdrive only today. Ask the owner whether normal mode gets any part of
this. Child agents.

**Tests:**
- The hedge detector, if it is added in code → `npm test` (pure).
- Rung behaviour → the existing `llm` tests (`npm run test:llm`), extended.
- The snapshots → the owner runs `npm run approve`.

**Done when:** the approved wording is in place, and the self-check catches the two
field-test cases in a scripted replay.

---

### T08 — Engine timestamps for tasks and timers (High · R-2, U-03, U-04, U-05)

**Problem.**
- The Tasks panel sat at 0/7 while the engine was at task 5. That is the T01 backlog, and
  T01 must remove it. Check it here again.
- After the backlog, the durations were wrong: 7 s for a 2-minute task, 16 s for a
  17-minute task. The turn timer stood still at 26:53.

**Cause (confirmed):**
- `app/renderer/modules/tasks.js:32-63` stamps the start and end of a task with
  `Date.now()` when the frame is **handled** (`:39-44`), and the ticker is at `:15-30`.
- The turn timer is `nowTurnStart` (`views.js:360`, `Date.now()`), ticked by `tickNowLine`
  (`:348-354`).
- `tabs.js:57-58, 447-449, 472, 477` save and restore these values per tab.
- **No engine frame carries a timestamp** (`engine/protocol/src/types.ts:91-302`).
- The engine→main timing is right: the main process log has every `task_list_updated` at
  the correct time.

**Change:**
- Add an engine timestamp. Choose between:
  - (a) an optional `at` (epoch ms) on the frames that need it (`turn_started`,
    `turn_finished`, `task_list_updated` or per-task status-change times,
    `tool_call_started/finished`);
  - (b) one transport-level field on every frame.

  This is a **protocol change**: ask the owner which shape. Update `tui/src/protocol.ts`
  in the same change.
- The renderer uses the engine times for task durations and the turn timer. Keep a
  fallback to `Date.now()` for an older engine, if the protocol version allows one.
- Look at `TaskItem` too: the engine could keep `startedAt` / `completedAt` per task, which
  also survives resume.

**System-wide:**
- The TUI's TaskStrip and LiveLine: show the same durations if they show any.
- Resume and replay must show correct durations.
- Background tabs.
- The clock difference between processes is zero here (same machine), but do not
  subtract engine and renderer times that come from different clocks without a reason.

**Tests:**
- `wire-round-trip.test.ts` needs samples for the changed frames. The compiler forces
  this.
- `tui-protocol-parity.test.ts` must stay green.
- The engine emits correct times → `npm test`.
- The renderer shows engine-based durations when delivery is delayed → `npm run test:ui`,
  sending the frames late through the real IPC.

**Done when:** a delayed delivery no longer changes the durations or freezes the timer.

---

### T09 — UI: reasoning vs progress, sessions, retries, small defects (Medium · U-06…U-09)

**Do (each item needs its own test):**
- **U-06, reasoning vs progress:** make sure that tool calls and file changes are clearly
  separate from reasoning, and that the reasoning stays collapsed by default. The
  screenshot showed it open. **Ask the owner** whether they opened it by hand, or whether
  something opens it. Show tokens and elapsed time in the summary (with T04).
- **U-07, sessions list:** `requestSessionList()` (`landing.js:53-56`) is called on
  session start, on workspace open and on navigation, **but not when a turn ends or on the
  first message** (confirmed). The live session was missing for the whole run. Refresh it
  when a turn ends (or when the transcript first gets a message), for each tab/workspace.
  Check the TUI's SessionPicker for the same issue.
- **U-08, retries:** `retry_status` IS handled (`landing.js:1044-1048` → `showNowOverride`,
  `views.js:337-346`). It was invisible only because of T01. Add a `ui` test that shows
  the notice, and check the TUI (`useEngine.ts:619`).
- **U-09, remaining items:**
  - The horizontal scroll bar under the conversation: `#transcript` sets only
    `overflow-y` (`styles.css:735`), and `.tool-row` has `white-space: nowrap` (`:857`).
    **(Unconfirmed cause — reproduce it with a test first.)**
  - The model label: `shortModelLabel` (`session.js:110-113`) strips only the first `/`
    segment, so `accounts/fireworks/models/glm-5p3` stays long in a 210/150 px select
    (`styles.css:957, 1378`). Show the last segment, with the full id in a tooltip.

**Tests:** `npm run test:ui` for all four, with real DOM measurements (for example
`scrollWidth > clientWidth`), no screenshots needed. Revert-verify.

**Done when:** each item has a passing test that failed before.

---

### T10 — Output tokens: show the reasoning part (Medium · U-10, owner question)

**The owner's question:** "In Claude Code thinking does not increase the output token
count; in MAGENTRA it does. Which is correct?"

**Answer (from the provider documents, 2026-09-23):** MAGENTRA is correct to count
reasoning as output.
- Anthropic: thinking tokens are billed as output tokens.
  `usage.output_tokens_details.thinking_tokens` reports "how many of the billed output
  tokens were internal reasoning" (https://platform.claude.com/docs/en/build-with-claude/extended-thinking).
- OpenAI: reasoning tokens "are billed as output tokens", are reported in
  `output_tokens_details.reasoning_tokens` (Chat Completions:
  `completion_tokens_details.reasoning_tokens`), and "occupy space in the model's context
  window" (https://developers.openai.com/api/docs/guides/reasoning).

**So do NOT remove reasoning from the output count. Add the breakdown.**

**Where:**
- The `Usage` type has only `inputTokens/outputTokens/cacheRead/cacheWrite`
  (`engine/protocol/src/types.ts:30-38`).
- No provider reads a reasoning-token field today (confirmed by grep in
  `engine/providers/src`).
- The live counter estimates from characters, reasoning + text together
  (`session.ts:1951`, `estimateTokens(text.length + thinking.length)`).
- `SessionStats` (`sessionStats.ts`), the session report, the desktop meter
  (`app/renderer/modules/tokens.js`), and the TUI (`TranscriptLine.tsx:265`,
  `useEngine.ts:614-642`).

**Change:**
- Add an optional `reasoningTokens` to `Usage` (a protocol change: TUI mirror and wire
  samples).
- Parse it in the OpenAI-compatible provider (`completion_tokens_details.reasoning_tokens`
  and the Responses-API form) and the Anthropic provider (the thinking-token detail, where
  present).
- Split the live estimate by `thinking.length` vs `text.length`, and mark it as estimated
  until the provider usage lands.
- Show "out 200k · reasoning 135k" (the wording is the owner's choice) in the desktop meter,
  the TUI and `/session`.
- Check that the token algebra stays true (`one-token-algebra.test.ts`,
  `mirror-token-algebra.test.ts`, `context-accounting.test.ts`).

**Find out** whether Fireworks (GLM-5.3) sends `reasoning_tokens`. If it does not, the
split stays "estimated". Write down what you found.

**Tests:**
- Usage normalization for both providers → `npm test` (`usage-normalization.test.ts`,
  `provider-usage-normalization.test.ts`; the provider wire is `net`, as in
  `openai-compatible-is-negotiated-not-assumed.test.ts`).
- The meter display → `npm run test:ui`.
- One `llm` test recording whether the configured provider reports the field →
  `npm run test:llm`.
- The TUI parity test must stay green.

**Done when:** the total is unchanged and correct, and the reasoning part is visible
everywhere tokens are shown.

---

### T11 — Less silent drafting, short Edit anchors (Medium/Low · M-01, M-02, M-04, M-05)

**Problem.**
- 537 280 characters of reasoning against 13 218 characters of text for the user; about
  two thirds of the output tokens were reasoning.
- The model drafted whole files in its reasoning and then wrote them again (M-02).
- It used a 1 249-character `old_string` taken from memory (M-04).
- It ignored the 12-character header limit, which IS in the schema description
  (`askUserQuestion.ts:12`, M-05).

**Change (prompt and tool-description text → rule 10, owner approval):**
- Guidance to plan briefly and write files instead of drafting them in the reasoning
  (`SECTION_WORKING_METHOD`, `prompts.ts:59-66`).
- The Edit tool description: use a short, unique anchor copied from the latest Read.
- Measure first: see how the reasoning effort setting (`reasoning-effort-clamp`,
  `mirror-reasoning-efforts`) was set for this run (Think: default), and whether a lower
  default for build tasks is a better lever than more prompt text. Ask the owner.

**Tests:** prompt snapshots (the owner approves). Optionally, an `llm` behaviour check
(`npm run test:llm`).

**Done when:** the approved wording is live and the snapshots are re-approved by the owner.

---

### T12 — Tool frame pairing and background-job waits (Medium · E-02, E-03)

**E-02 (confirmed).** For 4 early-rejection paths in `session.ts`, a
`tool_call_finished` is sent with no `tool_call_started` before it:
- unknown tool (`:2068-2078`);
- disabled tool (`:2055-2065`);
- unparseable JSON (`:2084-2090`);
- zod validation failure (`:2100-2109`).

`tool_call_started` is emitted only at `:2191-2197`, and `tool_call_finished` for every
call at `:2247-2253`.

- **Fix:** emit a started frame before the finished frame on those paths. Check how the
  desktop (`onToolCallFinished`) and the TUI handle a finished frame for an unknown id
  today, and make both show a row for the rejected call.
- **Tests:** `npm test` (`fs`, scripted engine). No test covers this today: for each of the
  4 paths, assert the order started → finished.

**E-03.** The server died at 18:44:17. The model's curl loop polled it for 31 s, and the
exit notice arrived only after the loop.
- Reminders are flushed only at a new user turn (`session.ts:1382`) or after a tool round
  (`:1808`).
- `TaskOutput` with `block:true` already waits for a job to exit (`taskControl.ts:43-69`).
- There is no "wait for a port OR the job's exit" helper. `Monitor`'s description points to
  a shell `until` loop instead.
- **Propose options to the owner:**
  - (a) a `wait_for` mode (port / file / log line / job exit, whichever comes first);
  - (b) the engine ends a foreground Bash poll early when a background job the session
    started exits with an error, and says so in the result;
  - (c) only guidance in the tool descriptions (rule 10).
- **Background jobs have no feature test today** (confirmed gap). Add one for the
  lifecycle (start/exit frames, the reminder, `TaskStop` / `TaskOutput`) before you change
  anything, so the current behaviour is pinned first.

**System-wide:** background notifications are shown in the desktop (`onBackgroundNotification`)
and in the TUI. Note that `tui-protocol-parity` has an owner exception for
`background_notification`. Keep it.

**Done when:** every tool call has a start and an end frame, and a dead job cannot keep
the agent polling unnoticed (per the owner's option).

---

### T13 — Edit error hint, shell-edit tracking, stats saved often (Medium/Low · E-05, E-04, E-06)

**E-05 (Medium): the Edit error.** Three Edits failed because the model mis-quoted the
file, for example one missing `/` in `"/GameConfig.Overrides.json"`. The error
(`engine/tools/src/edit.ts:52-55`) says only "old_string not found…".
- Add the closest match: the line and character where the best candidate first differs,
  and a short excerpt. Keep it cheap and bounded for big files.
- **Tests:** `tool-edit.test.ts` (`npm test`). Include the real field case: a one-character
  omission in a multi-line `old_string`.

**E-04 (Low): shell edits.**
- Bash never touches `FileState` (`bash.ts`: no `fileState` calls). `checkFresh`
  (`fileState.ts:31-46`) still catches a Bash edit of a file that was Read before, through
  mtime/size.
- The gap: an Edit after `sed -i` needs a new Read, and the model is not told which files
  the command changed.
- **Option:** snapshot mtime/size of the files already Read in the session before and after
  each Bash call, and list the changed ones in the Bash result. Measure the cost first.
- **Tests:** `file-freshness.test.ts` / `tool-bash.test.ts` (`npm test`).

**E-06 (Low): stats saved often.**
- The transcript `meta` record with the session stats is appended only in the turn's
  `finally` block (`session.ts:1888-1898`, root only). A crash during a long turn loses
  that turn's token data.
- Save the stats more often, for example after each model call, throttled. `engine.ts:611-618`
  and `:1490-1503` merge over the latest meta, so keep that pattern. Resume must read the
  latest record (`SessionStats.fromSnapshot`, `sessionStats.ts:196-217`).
- **Tests:** `npm test` (`fs`): stop a scripted turn in the middle, and assert that the
  stats of the calls already done are on disk. `resume.test.ts` and
  `session-report.test.ts` stay green.

**Done when:** all three have a test that failed before.

---

### T14 — Generate the new big picture (LAST)

**Why:** `docs/big-picture/` was deleted in commit `e2bc213`: `MAP.md`, `big-picture.html`,
`coverage.json`, `render.mjs`, `HARNESS-PERF-STATE.md` and `PERF-DEBUG-FINDINGS.md`.
`bigpicture.mjs check` exits 2. The root `BIG-PICTURE.pdf` is from before T01–T13.

**Do:**
1. Read the `bigpicture` skill. Get the old files from git
   (`git show e2bc213^:docs/big-picture/<file>`) as **source material only**. The owner
   asked for a NEW big picture, so do not restore them blindly.
2. `npm run build`, then `node .claude/skills/bigpicture/bigpicture.mjs map` to generate
   `docs/big-picture/MAP.md`.
3. Write `docs/big-picture/big-picture.html` fresh. It covers:
   - the architecture as it is after T01–T13: engine layers, protocol seam, desktop main /
     renderer / tabs, TUI, permissions and guards, the finishing ladder, token algebra,
     logging, tests and the gateway;
   - the invariants;
   - the known drift.

   Use every task's "files changed" list from the status board.
4. Write `docs/big-picture/coverage.json`: every section with the files that back it. A
   section that is not in it never goes stale. Restore or rewrite `render.mjs`, then
   `render` → `BIG-PICTURE.pdf`, then `sync`, and finally `check` exits 0.
5. Update the rest of `.claude/skills/bigboycoding/SKILL.md` and
   `.claude/skills/bigpicture/SKILL.md`, so their "Verified" sections and paths are true.
6. Ask the owner whether `HARNESS-PERF-STATE.md` / `PERF-DEBUG-FINDINGS.md` should come
   back.

**Done when:** `bigpicture.mjs check` exits 0, the PDF renders, and the owner has read the
new narrative.

---

## 3. Mapping to the report's "Recommended order of work"

| Report step | Findings | Task here |
|---|---|---|
| 1 | U-01 | T01 |
| 2 | U-02 | T02 |
| 3 | S-01 | T03 |
| 4 | M-06 | T04 |
| 5 | L-01, L-02 | T05 (with L-03, L-04 from step 14) |
| 6 | V-01, V-05 | T06 |
| 7 | V-02, V-03 | T07 (with V-04) |
| 8 | U-03 to U-05 | T08 |
| 9 | U-06, U-07, U-08 | T09 (with the rest of U-09 from step 14) |
| 10 | M-01, M-02 | T11 (with M-04, M-05) |
| 11 | E-02, E-03 | T12 |
| 12 | S-02 | T03 (same code area as S-01) |
| 13 | E-05, E-04, E-06 | T13 |
| 14 | L-03, L-04, U-09 | T05 and T09 |
| — | U-10 (owner question, added later) | T10 |
| — | E-01 | withdrawn (not a defect; see E-05) |
| — | new big picture | T14 (last) |

Out of scope: the game's own defects (mouse aim, player visibility, stairs feedback,
stuck bats, session leak). They are evidence for T06, not MAGENTRA tasks.
