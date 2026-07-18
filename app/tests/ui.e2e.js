"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain, session } = require("electron");

const WORKSPACE = "/tmp/magentra-ui-workspace";
const MODEL = "deepseek-ai/DeepSeek-V4-Flash";
const frames = [];
const calls = [];
const modes = [];
const permissions = [];
const signals = [];
const rendererErrors = [];
let windowRef = null;
let passed = 0;

const pause = (ms = 35) => new Promise((resolve) => setTimeout(resolve, ms));

function apiResult(name, args) {
  calls.push({ name, args });
  switch (name) {
    case "getConfig": return { workspace: null, model: MODEL, recentWorkspaces: [WORKSPACE] };
    case "chooseWorkspace":
    case "openWorkspace": return { workspace: WORKSPACE, model: MODEL };
    case "setModel": return { workspace: WORKSPACE, model: args[0] };
    case "getAppInfo": return { version: "0.0.0-test" };
    case "connectionInfo": return { baseUrl: "https://api.test/v1", model: MODEL, hasKey: true, contextWindow: 65536 };
    case "revealKey": return { key: "test-key" };
    case "getWebSearch": return true;
    case "testConnection": {
      // Echo the normalized base like the real main process (a pasted
      // ".../chat/completions" reduces to the base) so the wizard's
      // field-rewrite behavior is exercised.
      const raw = (args[0] && args[0].baseUrl) || "";
      const baseUrl = raw.replace(/\/+$/, "").replace(/\/(chat\/completions|models)$/i, "");
      return { ok: true, models: [MODEL], ...(baseUrl ? { baseUrl } : {}) };
    }
    case "pickDoc": return { ok: true, path: "/tmp/context.md" };
    default: return { ok: true };
  }
}

function wireTestIpc() {
  ipcMain.handle("test:api", (_event, payload) => apiResult(payload.name, payload.args || []));
  ipcMain.on("test:frame", (_event, frame) => frames.push(frame));
  ipcMain.on("test:modes", (_event, active) => modes.push(active));
  ipcMain.on("test:permission", (_event, value) => permissions.push(value));
  for (const name of ["interrupt", "restart", "reloadTeam", "external", "titlebar"]) {
    ipcMain.on(`test:${name}`, (_event, value) => signals.push({ name, value }));
  }
}

async function evaluate(source) {
  return windowRef.webContents.executeJavaScript(source, true);
}

async function emit(event) {
  windowRef.webContents.send("test:engine-event", event);
  await pause();
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    process.stdout.write(`✓ ${name}\n`);
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    throw error;
  }
}

async function run() {
  await test("landing uses the Concept A visual shell", async () => {
    const state = await evaluate(`(() => ({
      theme: document.documentElement.dataset.theme,
      sidebar: getComputedStyle(document.querySelector('#sidebar')).display,
      rain: Boolean(document.querySelector('#rain, #crt')),
      promptDisabled: document.querySelector('#promptInput').disabled,
      recentCount: document.querySelectorAll('.recent-row').length,
      title: document.querySelector('#workTitleText').textContent,
      version: document.querySelector('#sidebarVersion').textContent,
    }))()`);
    assert.deepEqual(state, {
      theme: "workbench", sidebar: "flex", rain: false, promptDisabled: true,
      recentCount: 1, title: "Start a new conversation", version: "v0.0.0-test",
    });
    // Keep the auto-starting first-run tour out of the unrelated scenarios;
    // the dedicated tour test below replays it explicitly via startTour(true).
    await evaluate(`localStorage.setItem('magentra-tour-done', '1')`);
  });

  await test("opening a recent workspace activates composer, sidebar, and inspector", async () => {
    await evaluate(`document.querySelector('.recent-row').click()`);
    await pause(60);
    const state = await evaluate(`(() => ({
      workspace: document.querySelector('#workspacePath').textContent,
      promptDisabled: document.querySelector('#promptInput').disabled,
      inspectorOpen: document.body.classList.contains('inspector-open'),
      inspectorHidden: document.querySelector('#taskRail').classList.contains('hidden'),
      sessionNavHidden: document.querySelector('#navSessions').classList.contains('hidden'),
      contextWorkspace: document.querySelector('#inspectorWorkspace').textContent,
    }))()`);
    assert.deepEqual(state, {
      workspace: "magentra-ui-workspace", promptDisabled: false, inspectorOpen: true,
      inspectorHidden: false, sessionNavHidden: false, contextWorkspace: "magentra-ui-workspace",
    });
    assert.ok(frames.some((frame) => frame.type === "list_sessions"));
  });

  await test("saved sessions render persistently and management controls send engine frames", async () => {
    await emit({
      type: "session_started", sessionId: "active-session", model: MODEL,
      commands: [{ cmd: "/help", args: "", desc: "commands" }, { cmd: "/sessions", args: "", desc: "saved sessions" }],
      rateCard: { [MODEL]: { input: 0.09, output: 0.18, contextWindow: 65536 } },
    });
    await emit({ type: "session_list", sessions: [
      { id: "active-session", label: "Concept A build", updatedAt: "2026-07-17T10:00:00Z", model: MODEL },
      { id: "older-session", firstUserMessage: "Audit the renderer", updatedAt: "2026-07-16T10:00:00Z", model: MODEL },
    ] });
    let state = await evaluate(`(() => ({
      sidebarRows: document.querySelectorAll('.sidebar-session').length,
      activeRows: document.querySelectorAll('.sidebar-session.active').length,
      title: document.querySelector('#workTitleText').textContent,
      session: document.querySelector('#inspectorSession').textContent,
    }))()`);
    assert.deepEqual(state, { sidebarRows: 2, activeRows: 1, title: "Concept A build", session: "active-session" });
    await evaluate(`document.querySelectorAll('.sidebar-session')[1].click()`);
    assert.ok(frames.some((frame) => frame.type === "resume_session" && frame.id === "older-session"));
    await evaluate(`document.querySelector('#navSessions').click()`);
    await pause();
    state = await evaluate(`(() => ({ view: document.body.dataset.view, rows: document.querySelectorAll('.session-row').length }))()`);
    assert.deepEqual(state, { view: "sessions", rows: 2 });
    await evaluate(`(() => { const input = document.querySelector('#sessionsSearch'); input.value = 'audit'; input.dispatchEvent(new Event('input')); })()`);
    assert.equal(await evaluate(`document.querySelectorAll('.session-row').length`), 1);
    await evaluate(`document.querySelector('.session-rename').click()`);
    await pause();
    assert.equal(await evaluate(`document.querySelector('#promptModal').classList.contains('hidden')`), false);
    await evaluate(`(() => { document.querySelector('#promptModalInput').value = 'Renamed audit'; document.querySelector('#promptModalOk').click(); })()`);
    await pause();
    assert.ok(frames.some((frame) => frame.type === "rename_session" && frame.label === "Renamed audit"));
    await evaluate(`document.querySelector('.session-actions').children[1].click()`);
    await pause();
    assert.ok(frames.some((frame) => frame.type === "archive_session" && frame.id === "older-session"));
    await evaluate(`(() => { window.confirm = () => true; document.querySelector('.session-actions').children[2].click(); })()`);
    await pause();
    assert.ok(frames.some((frame) => frame.type === "delete_session" && frame.id === "older-session"));
  });

  await test("task, mission, and crew surfaces remain live without leaving context", async () => {
    await evaluate(`document.querySelector('#sessionsCloseBtn').click()`);
    await emit({ type: "task_list_updated", tasks: [
      { id: "t1", subject: "Map current UI", status: "completed" },
      { id: "t2", subject: "Implement inspector", status: "in_progress", description: "Wire behavior" },
      { id: "t3", subject: "Verify interactions", status: "pending" },
    ] });
    assert.equal(await evaluate(`document.querySelector('#taskProgress').textContent`), "1/3");
    assert.equal(await evaluate(`document.querySelectorAll('#taskList .task-item').length`), 3);
    await emit({ type: "missions_updated", missions: [{
      id: "nightly-audit", name: "Nightly audit", description: "Review regressions", keywords: ["ui"],
      schedule: "0 2 * * *", scheduled: true, continuous: true, running: true, deliverable: "audit.md",
    }], warnings: [] });
    assert.equal(await evaluate(`document.querySelectorAll('.sidebar-mission').length`), 1);
    await evaluate(`document.querySelector('.sidebar-mission').click()`);
    assert.equal(await evaluate(`document.body.dataset.view`), "lab");
    await evaluate(`(() => {
      const buttons = [...document.querySelectorAll('.lab-btn')];
      buttons.find((button) => button.textContent === 'STOP').click();
      buttons.find((button) => button.textContent === 'UNSCHEDULE').click();
      buttons.find((button) => button.textContent === 'RUN').click();
    })()`);
    await pause();
    assert.ok(frames.some((frame) => frame.type === "slash_command" && frame.command === "mission" && frame.args === "run nightly-audit"));
    assert.ok(frames.some((frame) => frame.type === "slash_command" && frame.args === "stop nightly-audit"));
    assert.ok(frames.some((frame) => frame.type === "slash_command" && frame.args === "unschedule nightly-audit"));
    await emit({ type: "missions_updated", missions: [{
      id: "nightly-audit", name: "Nightly audit", description: "Review regressions", keywords: ["ui"],
      schedule: "0 2 * * *", scheduled: false, continuous: true, running: false, deliverable: "audit.md",
    }], warnings: [] });
    await evaluate(`(() => {
      const buttons = [...document.querySelectorAll('.lab-btn')];
      buttons.find((button) => button.textContent === 'START').click();
      buttons.find((button) => button.textContent === 'SCHEDULE').click();
    })()`);
    await pause();
    assert.ok(frames.some((frame) => frame.type === "slash_command" && frame.args === "start nightly-audit"));
    assert.ok(frames.some((frame) => frame.type === "slash_command" && frame.args === "schedule nightly-audit"));
    await evaluate(`document.querySelector('#sidebarMissionNew').click()`);
    await pause();
    await evaluate(`(() => { document.querySelector('#promptModalInput').value = 'ui-audit'; document.querySelector('#promptModalOk').click(); })()`);
    await pause();
    assert.ok(frames.some((frame) => frame.type === "slash_command" && frame.command === "mission" && frame.args === "new ui-audit"));
    await emit({ type: "team_updated", agents: [
      { id: "reviewer", name: "Reviewer", role: "Find regressions", model: MODEL, ready: true, emoji: "R" },
      { id: "tester", name: "Tester", role: "Exercise UI", model: MODEL, ready: false, emoji: "T" },
    ] });
    await evaluate(`document.querySelector('.inspector-tab[data-inspector="crew"]').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('.inspector-crew-card').length`), 2);
    assert.equal(await evaluate(`document.querySelector('#inspectorCrewCount').textContent`), "2");
    await evaluate(`document.querySelector('#openCrewViewBtn').click()`);
    assert.equal(await evaluate(`document.body.dataset.view`), "team");
    assert.equal(await evaluate(`document.querySelectorAll('.crew-card').length`), 2);
    await evaluate(`document.querySelector('#teamReloadBtn').click(); document.querySelector('.crew-add').click()`);
    await pause();
    assert.ok(signals.some((signal) => signal.name === "reloadTeam"));
    assert.ok(calls.some((call) => call.name === "createTeamTemplate"));
    await evaluate(`document.querySelector('.crew-menu-btn').click(); document.querySelectorAll('.ctx-item')[0].click()`);
    await pause();
    assert.ok(calls.some((call) => call.name === "editAgent" && call.args[0] === "reviewer"));
    await evaluate(`document.querySelector('.crew-menu-btn').click(); document.querySelectorAll('.ctx-item')[1].click()`);
    await pause();
    assert.ok(calls.some((call) => call.name === "pickDoc" && call.args[0] === "reviewer"));
    await evaluate(`document.querySelector('.crew-menu-btn').click(); document.querySelectorAll('.ctx-item')[2].click()`);
    await pause();
    assert.ok(frames.some((frame) => frame.type === "slash_command" && frame.command === "crew" && frame.args === "export reviewer"));
    await evaluate(`document.querySelector('#teamBtn').click(); document.querySelector('.crew-menu-btn').click(); document.querySelectorAll('.ctx-item')[3].click()`);
    await pause();
    assert.ok(calls.some((call) => call.name === "removeAgent" && call.args[0] === "reviewer"));
    await evaluate(`document.querySelector('#teamHireBtn').click()`);
    await pause();
    await evaluate(`(() => { document.querySelector('#promptModalInput').value = '/tmp/reviewer.crewpack.json'; document.querySelector('#promptModalOk').click(); })()`);
    await pause();
    assert.ok(frames.some((frame) => frame.type === "slash_command" && frame.command === "crew" && frame.args.includes("hire /tmp/reviewer.crewpack.json")));
    await evaluate(`document.querySelector('#teamBtn').click(); document.querySelector('#draftTeamBtn').click()`);
    await pause();
    assert.ok(frames.some((frame) => frame.type === "user_message" && frame.text.includes("propose a crew for it")));
  });

  await test("permission, attach, model, and composer controls act on runtime state", async () => {
    await evaluate(`document.querySelector('#teamCloseBtn').click()`);
    const before = frames.length;
    await evaluate(`document.querySelector('#permissionMenuBtn').click(); document.querySelector('[data-permission="plan"]').click()`);
    await pause();
    const permissionState = await evaluate(`(() => ({
      label: document.querySelector('#permissionMenuLabel').textContent,
      hidden: document.querySelector('#permissionMenu').classList.contains('hidden'),
      planChecked: document.querySelector('[data-permission="plan"]').getAttribute('aria-checked'),
    }))()`);
    assert.ok(
      frames.slice(before).some((frame) => frame.type === "set_mode" && frame.mode === "plan"),
      `permission click state=${JSON.stringify(permissionState)} frames=${JSON.stringify(frames.slice(before))}`,
    );
    assert.equal(await evaluate(`document.querySelector('#permissionMenuLabel').textContent`), "Plan only");
    await evaluate(`document.querySelector('#permissionMenuBtn').click(); document.querySelector('[data-permission="ask"]').click()`);
    await pause();
    assert.ok(frames.some((frame) => frame.type === "set_mode" && frame.mode === "default"));
    await evaluate(`document.querySelector('#permissionMenuBtn').click(); document.querySelector('[data-permission="auto"]').click()`);
    await pause();
    assert.ok(frames.some((frame) => frame.type === "set_mode" && frame.mode === "bypass"));
    await evaluate(`document.querySelector('#attachBtn').click()`);
    assert.equal(await evaluate(`document.querySelector('#promptInput').value`), "@");
    await evaluate(`(() => { const input = document.querySelector('#promptInput'); input.value = 'Explain this workspace'; input.dispatchEvent(new Event('input')); input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); })()`);
    await pause();
    assert.ok(frames.some((frame) => frame.type === "user_message" && frame.text === "Explain this workspace"));
    assert.equal(await evaluate(`document.querySelectorAll('.msg-user').length > 0`), true);
    await evaluate(`(() => { const select = document.querySelector('#modelSelect'); select.value = 'Qwen/Qwen3-14B'; select.dispatchEvent(new Event('change')); })()`);
    await pause();
    assert.ok(calls.some((call) => call.name === "setModel" && call.args[0] === "Qwen/Qwen3-14B"));
    await evaluate(`(() => {
      const select = document.querySelector('#modelSelect');
      select.value = '__custom__'; select.dispatchEvent(new Event('change'));
      const custom = document.querySelector('#customModel'); custom.value = 'local/custom-model';
      custom.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
    })()`);
    await pause();
    assert.ok(calls.some((call) => call.name === "setModel" && call.args[0] === "local/custom-model"));
    await evaluate(`(() => { const input = document.querySelector('#promptInput'); input.value = '! npm test'; input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); })()`);
    await pause();
    assert.ok(frames.some((frame) => frame.type === "bang_command" && frame.cmd === "npm test"));
    await evaluate(`document.querySelector('#promptInput').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowUp', bubbles:true}))`);
    assert.equal(await evaluate(`document.querySelector('#promptInput').value`), "! npm test");
    await evaluate(`document.querySelector('#promptInput').value = ''`);
  });

  await test("streaming, operation expansion, agent activity, queueing, and stop work", async () => {
    await emit({ type: "turn_started" });
    await emit({ type: "thinking_delta", text: "Inspecting the renderer" });
    await emit({ type: "tool_call_started", id: "read-1", tool: "Read", description: "Read events.js", input: { file_path: "app/renderer/modules/events.js" } });
    await emit({ type: "tool_output_delta", id: "read-1", text: "const sessionChanges" });
    await emit({ type: "tool_call_finished", id: "read-1", tool: "Read", resultPreview: "206 lines", isError: false });
    await emit({ type: "agent_spawned", agentId: "a1", agentDesc: "Review CSS", agentName: "Reviewer" });
    await emit({ type: "agent_finished", agentId: "a1", isError: false });
    await emit({ type: "text_delta", text: "Implemented **Concept A**." });
    assert.equal(await evaluate(`document.querySelectorAll('.tool-row').length > 0`), true);
    await evaluate(`document.querySelector('.tool-row').click()`);
    assert.equal(await evaluate(`document.querySelector('.tool-row').getAttribute('aria-expanded')`), "true");
    await evaluate(`(() => { const input = document.querySelector('#promptInput'); input.value = 'Now verify it'; document.querySelector('#sendBtn').click(); })()`);
    assert.equal(await evaluate(`document.querySelector('#queueChip').classList.contains('hidden')`), false);
    await evaluate(`document.querySelector('#stopBtn').click()`);
    await pause();
    assert.ok(signals.some((signal) => signal.name === "interrupt"));
    await emit({ type: "turn_finished", contextTokens: 4200, totalCostUsd: 0.012, stopReason: "end_turn" });
    assert.ok(frames.some((frame) => frame.type === "user_message" && frame.text === "Now verify it"));
    assert.match(await evaluate(`document.querySelector('#inspectorUsage').textContent`), /4\.2k ctx/);
  });

  await test("slash palette, background jobs, application menu, and recovery banner are live controls", async () => {
    await evaluate(`(() => { const input = document.querySelector('#promptInput'); input.value = '/'; input.dispatchEvent(new Event('input')); })()`);
    assert.equal(await evaluate(`document.querySelector('#slashPop').classList.contains('hidden')`), false);
    assert.equal(await evaluate(`document.querySelectorAll('.slash-item').length > 0`), true);
    await evaluate(`document.querySelector('#promptInput').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
    assert.equal(await evaluate(`document.querySelector('#slashPop').classList.contains('hidden')`), true);
    await evaluate(`(() => { const input = document.querySelector('#promptInput'); input.value = '/help'; input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); })()`);
    await pause();
    assert.ok(frames.some((frame) => frame.type === "slash_command" && frame.command === "help"));

    await emit({ type: "background_notification", taskId: "atlas-1", kind: "start", payload: { description: "Mapping workspace" } });
    assert.equal(await evaluate(`document.querySelector('#jobsChip').classList.contains('hidden')`), false);
    await evaluate(`document.querySelector('.job-stop').click()`);
    await pause();
    assert.ok(frames.some((frame) => frame.type === "stop_background" && frame.taskId === "atlas-1"));
    await emit({ type: "background_notification", taskId: "atlas-1", kind: "exit" });
    assert.equal(await evaluate(`document.querySelector('#jobsChip').classList.contains('hidden')`), true);

    await evaluate(`document.querySelector('.menu-root').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('.menu-group-label').length`), 4);
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
    assert.equal(await evaluate(`document.querySelector('.menu-panel') === null`), true);

    await emit({ type: "error", message: "Engine unavailable", fatal: true });
    assert.equal(await evaluate(`document.querySelectorAll('.engine-banner').length > 0`), true);
    await evaluate(`document.querySelector('.engine-banner-btn').click()`);
    await pause();
    assert.ok(signals.some((signal) => signal.name === "restart"));
  });

  const firstDiff = [
    "diff --git a/app.js b/app.js", "index 1111111..2222222 100644", "--- a/app.js", "+++ b/app.js",
    "@@ -1 +1 @@", "-const theme = 'old';", "+const theme = 'workbench';", "",
  ].join("\n");
  const secondDiff = [
    "diff --git a/styles.css b/styles.css", "index 3333333..4444444 100644", "--- a/styles.css", "+++ b/styles.css",
    "@@ -1 +1,2 @@", " body {}", "+.inspector {}", "",
  ].join("\n");

  await test("file edits produce inline evidence, review tabs, open, and undo", async () => {
    await emit({ type: "file_edited", path: "app.js", diff: firstDiff });
    await emit({ type: "file_edited", path: "styles.css", diff: secondDiff });
    let state = await evaluate(`(() => ({
      inline: document.querySelectorAll('.inline-changes-card').length,
      count: document.querySelector('#inspectorChangesCount').textContent,
      summary: document.querySelector('#inspectorChangesSummary').textContent,
    }))()`);
    assert.equal(state.inline, 1);
    assert.equal(state.count, "2");
    assert.match(state.summary, /2 files/);
    await evaluate(`document.querySelector('.inspector-tab[data-inspector="changes"]').click(); document.querySelectorAll('.inspector-change-row')[1].click()`);
    state = await evaluate(`(() => ({
      open: !document.querySelector('#reviewDrawer').classList.contains('hidden'),
      file: document.querySelector('#reviewFileName').textContent,
      additions: document.querySelectorAll('#reviewDiff .review-line.add').length,
      tabs: document.querySelectorAll('.review-file-tab').length,
      composerFits: document.querySelector('.composer-inner').scrollWidth <= document.querySelector('.composer-inner').clientWidth,
    }))()`);
    assert.deepEqual(state, { open: true, file: "styles.css", additions: 1, tabs: 2, composerFits: true });
    if (process.env.MAGENTRA_UI_CAPTURE) {
      await pause(80); // let Chromium commit the drawer before capturePage()
      const screenshot = await windowRef.capturePage();
      fs.writeFileSync(process.env.MAGENTRA_UI_CAPTURE, screenshot.toPNG());
    }
    await evaluate(`document.querySelector('#reviewOpenBtn').click()`);
    await pause();
    assert.ok(calls.some((call) => call.name === "openWorkspaceFile" && call.args[0] === "styles.css"));
    await evaluate(`document.querySelector('#reviewUndoBtn').click()`);
    await pause(60);
    assert.equal(await evaluate(`document.querySelector('#inspectorChangesCount').textContent`), "1");
    assert.ok(calls.some((call) => call.name === "undoChanges" && call.args[0] === "styles.css"));
    await evaluate(`document.querySelector('#reviewDoneBtn').click()`);
    assert.equal(await evaluate(`document.body.classList.contains('review-open')`), false);
    await evaluate(`document.querySelector('.menu-root').click(); [...document.querySelectorAll('.menu-item')].find((button) => button.textContent.trim().startsWith('Changes')).click()`);
    assert.equal(await evaluate(`document.body.dataset.view`), "changes");
    await evaluate(`document.querySelector('.change-file').click()`);
    assert.equal(await evaluate(`document.querySelector('.change-file').getAttribute('aria-expanded')`), "true");
    await evaluate(`document.querySelector('#changesCloseBtn').click()`);
    await evaluate(`document.querySelector('#undoLastBtn').click()`);
    await pause(60);
    assert.equal(await evaluate(`document.querySelector('#inspectorChangesCount').textContent`), "");
    assert.equal(await evaluate(`document.querySelector('.inline-changes-card') === null`), true);
  });

  await test("approval, question, and plan cards send selected decisions", async () => {
    await emit({ type: "permission_request", id: "p1", description: "Remove generated file", input: { command: "rm generated.js" } });
    assert.equal(await evaluate(`document.querySelector('#deleteModal').classList.contains('hidden')`), false);
    await evaluate(`document.querySelector('#allowBtn').click()`);
    await pause();
    assert.deepEqual(permissions.at(-1), { id: "p1", decision: "allow_once" });
    await emit({ type: "question_request", questions: [{
      header: "Scope", question: "Which surface?", multiSelect: false,
      options: [{ label: "Workbench (Recommended)", description: "Use Concept A" }, { label: "Legacy", description: "Keep old shell" }],
    }] });
    assert.equal(await evaluate(`document.querySelectorAll('.question-card').length > 0`), true);
    await evaluate(`document.querySelector('.question-card .q-opt').click()`);
    await pause();
    assert.ok(frames.some((frame) => frame.type === "question_response"));
    await emit({ type: "plan_ready", plan: "1. Inspect\n2. Implement\n3. Verify" });
    assert.equal(await evaluate(`document.querySelectorAll('.plan-card').length > 0`), true);
    await evaluate(`document.querySelector('.plan-card .plan-approve').click()`);
    await pause();
    assert.ok(frames.some((frame) => frame.type === "plan_decision" && frame.approve === true));
  });

  await test("skills view, chips, recommended set, and create-skill wizard are functional", async () => {
    await emit({ type: "modes_updated", modes: [
      { id: "grill", name: "Grill", description: "Challenge assumptions", why: "Stress-test plans before code", active: false, recommended: false, conflicts: [] },
      { id: "prover", name: "Prover", description: "Prove every change", why: "Enable when correctness matters", active: false, recommended: true, conflicts: [] },
    ] });
    // Hero chip toggles a skill through the shared set_modes path.
    await evaluate(`document.querySelector('.mode-chip.hero').click()`);
    await pause();
    assert.ok(modes.some((active) => active.includes("grill")));
    // The summary chip opens the Skills view; both cards render with badges + why.
    await evaluate(`document.querySelector('#skillsSummary').click()`);
    await pause();
    let state = await evaluate(`(() => ({
      view: document.body.dataset.view,
      cards: document.querySelectorAll('.skill-card').length,
      badges: document.querySelectorAll('.skill-badge').length,
      whyHidden: document.querySelectorAll('.skill-why.hidden').length,
    }))()`);
    assert.deepEqual(state, { view: "skills", cards: 2, badges: 1, whyHidden: 2 });
    // The ? explainer reveals the why copy.
    await evaluate(`document.querySelectorAll('.skill-why-btn')[0].click()`);
    assert.equal(await evaluate(`document.querySelectorAll('.skill-why:not(.hidden)').length`), 1);
    // A card toggle flips the discipline via set_modes.
    modes.length = 0;
    await evaluate(`[...document.querySelectorAll('.skill-card')].find((c) => c.querySelector('.skill-name').textContent === 'Prover').querySelector('.skill-toggle').click()`);
    await pause();
    assert.ok(modes.some((active) => active.includes("prover")));
    // Enable-recommended enables every badged skill at once.
    await emit({ type: "modes_updated", modes: [
      { id: "grill", name: "Grill", description: "Challenge assumptions", why: "", active: false, recommended: false, conflicts: [] },
      { id: "prover", name: "Prover", description: "Prove every change", why: "", active: false, recommended: true, conflicts: [] },
    ] });
    modes.length = 0;
    await evaluate(`document.querySelector('#skillsRecommendBtn').click()`);
    await pause();
    assert.ok(modes.some((active) => active.includes("prover")));
    // Create-skill wizard: describe → generate_skill frame → draft preview → install_skill frame.
    await evaluate(`document.querySelector('#skillCreateBtn').click()`);
    assert.equal(await evaluate(`document.querySelector('#skillWizard').classList.contains('hidden')`), false);
    await evaluate(`(() => {
      document.querySelector('#skillDescInput').value = 'Always write rollback SQL beside every migration';
      document.querySelector('#skillWizGenerate').click();
    })()`);
    await pause();
    assert.ok(frames.some((frame) => frame.type === "generate_skill" && frame.kind === "discipline"));
    await emit({ type: "skill_draft", ok: true, suggestedFilename: "sql-rollback.md", text: "---\\nkind: discipline\\nname: SQL Rollback\\n---\\n\\nAlways pair migrations with rollbacks." });
    state = await evaluate(`(() => ({
      step2: !document.querySelector('#skillWizStep2').classList.contains('hidden'),
      file: document.querySelector('#skillWizFile').textContent,
      hasText: document.querySelector('#skillDraftText').value.includes('rollbacks'),
    }))()`);
    assert.deepEqual(state, { step2: true, file: "sql-rollback.md", hasText: true });
    await evaluate(`document.querySelector('#skillWizInstall').click()`);
    await pause();
    assert.ok(frames.some((frame) => frame.type === "install_skill" && frame.filename === "sql-rollback.md"));
    assert.equal(await evaluate(`document.querySelector('#skillWizard').classList.contains('hidden')`), true);
    // Action skills from skills_updated render as on-demand cards.
    await emit({ type: "skills_updated", skills: [{ name: "sql-review", description: "Review SQL before it runs" }] });
    assert.equal(await evaluate(`document.querySelectorAll('.skill-card.action').length`), 1);
    await evaluate(`document.querySelector('#skillsCloseBtn').click()`);
  });

  await test("the teaching tour walks all eight steps and is replayable", async () => {
    await evaluate(`startTour(true)`);
    let state = await evaluate(`(() => ({
      visible: !document.querySelector('#tourOverlay').classList.contains('hidden'),
      label: document.querySelector('#tourStepLabel').textContent,
    }))()`);
    assert.deepEqual(state, { visible: true, label: "1 / 8" });
    for (let i = 0; i < 7; i++) await evaluate(`document.querySelector('#tourNext').click()`);
    assert.equal(await evaluate(`document.querySelector('#tourNext').textContent`), "FINISH ▸");
    await evaluate(`document.querySelector('#tourNext').click()`);
    assert.equal(await evaluate(`document.querySelector('#tourOverlay').classList.contains('hidden')`), true);
    // Esc skips a replayed tour immediately.
    await evaluate(`startTour(true)`);
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
    assert.equal(await evaluate(`document.querySelector('#tourOverlay').classList.contains('hidden')`), true);
  });

  await test("settings, shortcuts, inspector, and setup recovery are functional", async () => {
    await evaluate(`document.querySelector('#navSettings').click()`);
    await pause();
    assert.equal(await evaluate(`document.body.dataset.view`), "settings");
    await evaluate(`document.querySelector('[data-motion="calm"]').click()`);
    assert.equal(await evaluate(`document.documentElement.dataset.motion`), "calm");
    await evaluate(`document.querySelector('[data-size="15"]').click(); document.querySelector('[data-detail="cinematic"]').click(); document.querySelector('[data-deletions="allow"]').click()`);
    await pause();
    assert.equal(await evaluate(`getComputedStyle(document.documentElement).fontSize`), "15px");
    assert.equal(await evaluate(`document.documentElement.dataset.detail`), "cinematic");
    assert.ok(frames.some((frame) => frame.type === "set_deletion_guard" && frame.enabled === false));
    await evaluate(`document.querySelector('#setKeyReveal').click()`);
    await pause();
    assert.equal(await evaluate(`document.querySelector('#setApiKey').value`), "test-key");
    await evaluate(`document.querySelector('#setTestBtn').click(); document.querySelector('[data-websearch="off"]').click()`);
    await pause();
    assert.ok(calls.some((call) => call.name === "testConnection"));
    assert.ok(calls.some((call) => call.name === "setWebSearch" && call.args[0] === false));
    await evaluate(`document.querySelector('#setSaveBtn').click(); document.querySelector('#openLogsBtn').click()`);
    await pause();
    assert.ok(calls.some((call) => call.name === "writeEnv"));
    assert.ok(calls.some((call) => call.name === "openLogs"));
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'?', bubbles:true}))`);
    assert.equal(await evaluate(`document.querySelector('#shortcutSheet').classList.contains('hidden')`), false);
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
    assert.equal(await evaluate(`document.querySelector('#shortcutSheet').classList.contains('hidden')`), true);
    await evaluate(`document.querySelector('#taskCollapse').click()`);
    assert.equal(await evaluate(`document.body.classList.contains('inspector-open')`), false);
    await evaluate(`document.querySelector('#taskTab').click()`);
    assert.equal(await evaluate(`document.body.classList.contains('inspector-open')`), true);

    await evaluate(`document.querySelector('#navConsole').click()`);
    await pause();
    assert.equal(await evaluate(`document.body.dataset.view`), "console");
    assert.ok(frames.some((frame) => frame.type === "slash_command" && frame.command === "clear"));
    windowRef.webContents.send("test:setup-required", { workspace: WORKSPACE });
    await pause();
    assert.equal(await evaluate(`document.querySelector('#setupWizard').classList.contains('hidden')`), false);
    await evaluate(`(() => {
      document.querySelector('#wizApiKey').value = 'wizard-test-key';
      document.querySelector('#wizApiKey').dispatchEvent(new Event('input'));
      document.querySelector('#wizTestBtn').click();
    })()`);
    await pause();
    assert.equal(await evaluate(`document.querySelector('#wizStatus').textContent`), "link established");
    await evaluate(`document.querySelector('#wizStartBtn').click()`);
    await pause();
    assert.ok(calls.filter((call) => call.name === "writeEnv").length >= 2);
    assert.equal(await evaluate(`document.querySelector('#setupWizard').classList.contains('hidden')`), true);
  });

  await test("custom endpoint wizard: pasted URL normalizes, keyless + self-signed works, model stays aligned", async () => {
    windowRef.webContents.send("test:setup-required", { workspace: WORKSPACE });
    await pause();
    await evaluate(`document.querySelector('[data-preset="custom"]').click()`);
    let state = await evaluate(`(() => ({
      insecureVisible: !document.querySelector('#wizInsecureRow').hidden,
      hintVisible: !document.querySelector('#wizBaseUrlHint').hidden,
    }))()`);
    assert.deepEqual(state, { insecureVisible: true, hintVisible: true });
    // Paste the full completions URL a script would use, keyless, self-signed.
    await evaluate(`(() => {
      const base = document.querySelector('#wizBaseUrl');
      base.value = 'https://gw.example/coder/v1/chat/completions';
      base.dispatchEvent(new Event('input'));
      document.querySelector('#wizInsecure').checked = true;
      document.querySelector('#wizInsecure').dispatchEvent(new Event('change'));
      const model = document.querySelector('#wizModel');
      model.value = 'qwen3.6-35b-a3b';
      model.dispatchEvent(new Event('input'));
      document.querySelector('#wizTestBtn').click();
    })()`);
    await pause();
    const testCall = calls.filter((c) => c.name === "testConnection").pop();
    assert.equal(testCall.args[0].insecureTls, true);
    assert.equal(testCall.args[0].apiKey, "");
    // The field now shows the base that will actually be saved.
    assert.equal(await evaluate(`document.querySelector('#wizBaseUrl').value`), "https://gw.example/coder/v1");
    // IGNITE proceeds keyless without an "untested" warning (TEST just passed).
    await evaluate(`document.querySelector('#wizStartBtn').click()`);
    await pause();
    const envCall = calls.filter((c) => c.name === "writeEnv").pop();
    assert.equal(envCall.args[0].insecureTls, true);
    assert.equal(envCall.args[0].baseUrl, "https://gw.example/coder/v1");
    assert.equal(envCall.args[0].model, "qwen3.6-35b-a3b");
    assert.equal(await evaluate(`document.querySelector('#setupWizard').classList.contains('hidden')`), true);
    // The engine announces the configured model — the composer picker follows
    // without the user touching it, even for an id outside the preset list.
    await emit({ type: "session_started", sessionId: "sess-custom", model: "qwen3.6-35b-a3b", commands: [], rateCard: {} });
    state = await evaluate(`(() => ({
      select: document.querySelector('#modelSelect').value,
      custom: document.querySelector('#customModel').value,
      customVisible: !document.querySelector('#customModel').classList.contains('hidden'),
    }))()`);
    assert.deepEqual(state, { select: "__custom__", custom: "qwen3.6-35b-a3b", customVisible: true });
    // Restore the default model for the remaining scenarios.
    await emit({ type: "session_started", sessionId: "sess-restore", model: MODEL, commands: [], rateCard: {} });
  });

  await test("responsive workbench collapses navigation and overlays inspector", async () => {
    windowRef.setSize(800, 620);
    await pause(80);
    const state = await evaluate(`(() => ({
      sidebarWidth: Math.round(document.querySelector('#sidebar').getBoundingClientRect().width),
      stageRight: getComputedStyle(document.querySelector('#stage')).right,
      logoTextHidden: getComputedStyle(document.querySelector('.logo-text')).display,
    }))()`);
    assert.equal(state.sidebarWidth, 72);
    assert.equal(state.stageRight, "0px");
    assert.equal(state.logoTextHidden, "none");
    await emit({ type: "file_edited", path: "app.js", diff: firstDiff });
    await evaluate(`document.querySelector('.inspector-tab[data-inspector="changes"]').click(); document.querySelector('.inspector-change-row').click()`);
    await pause(50);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#stage')).right`), "0px");
    assert.equal(await evaluate(`document.querySelector('#reviewDrawer').getBoundingClientRect().width <= window.innerWidth - 72`), true);
    await evaluate(`document.querySelector('#reviewDoneBtn').click()`);
  });

  if (rendererErrors.length > 0) throw new Error(`renderer errors:\n${rendererErrors.join("\n")}`);
  process.stdout.write(`\n${passed} real Electron UI scenarios passed.\n`);
}

wireTestIpc();
app.whenReady().then(async () => {
  try {
    const partition = "magentra-ui-e2e-" + process.pid;
    await session.fromPartition(partition).clearStorageData();
    windowRef = new BrowserWindow({
      width: 1280, height: 820, show: Boolean(process.env.MAGENTRA_UI_CAPTURE),
      webPreferences: {
        preload: path.join(__dirname, "test-preload.js"), contextIsolation: true,
        nodeIntegration: false, sandbox: false, partition,
      },
    });
    windowRef.webContents.on("console-message", (_event, level, message, line) => {
      if (Number(level) >= 3) rendererErrors.push(`${message} (line ${line})`);
    });
    await windowRef.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
    windowRef.webContents.send("test:recent", [WORKSPACE]);
    await pause(80);
    await run();
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    app.exit(1);
  }
});
