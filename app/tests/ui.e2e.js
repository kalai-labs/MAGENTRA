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
// Stateful mock of the global connection-profile store (main/profiles.js). Holds
// sanitized records (never a raw key — only hasKey), exactly what the IPC returns.
const profiles = [];
let profileSeq = 0;
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
    case "pickContextFiles":
      return { ok: true, files: [{ name: "context.md", ok: true, bytes: 24, kind: "text", text: "hello from an attached file" }] };
    case "detectLocalServers":
      // Ollama present, LM Studio absent — exercises both the enabled and the
      // grayed-out-with-a-reason paths.
      return {
        ollama: { available: true },
        lmstudio: { available: false, reason: "LM Studio wasn't found on this PC" },
      };
    case "listProfiles": return profiles.map((p) => ({ ...p }));
    case "saveProfile": {
      const payload = args[0] || {};
      const profileName = typeof payload.name === "string" ? payload.name.trim() : "";
      if (!profileName) return { ok: false, error: "profile name required" };
      const record = {
        id: typeof payload.id === "string" && payload.id ? payload.id : `prof-${++profileSeq}`,
        name: profileName,
        baseUrl: payload.baseUrl || "",
        model: payload.model || "",
        provider: payload.provider === "anthropic" ? "anthropic" : "openai-compat",
        contextWindow: payload.contextWindow ? String(payload.contextWindow) : "",
        allowInsecureTls: payload.insecureTls === true,
        hasKey: typeof payload.apiKey === "string" && payload.apiKey.trim() !== "",
      };
      const idx = profiles.findIndex((p) => p.id === record.id);
      if (idx >= 0) profiles[idx] = record;
      else profiles.unshift(record);
      return { ok: true, id: record.id, profiles: profiles.map((p) => ({ ...p })) };
    }
    case "deleteProfile": {
      const idx = profiles.findIndex((p) => p.id === args[0]);
      if (idx >= 0) profiles.splice(idx, 1);
      return { ok: true, profiles: profiles.map((p) => ({ ...p })) };
    }
    case "applyProfile": return { ok: true };
    default: return { ok: true };
  }
}

function wireTestIpc() {
  ipcMain.handle("test:api", (_event, payload) => apiResult(payload.name, payload.args || []));
  ipcMain.on("test:frame", (_event, frame) => frames.push(frame));
  ipcMain.on("test:modes", (_event, active) => modes.push(active));
  ipcMain.on("test:permission", (_event, value) => permissions.push(value));
  for (const name of ["interrupt", "restart", "external", "titlebar", "window-control"]) {
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
      rain: Boolean(document.querySelector('#rain, #crt, #matrixRain')),
      promptDisabled: document.querySelector('#promptInput').disabled,
      recentCount: document.querySelectorAll('.recent-row').length,
      title: document.querySelector('#workTitleText').textContent,
      version: document.querySelector('#sidebarVersion').textContent,
    }))()`);
    assert.deepEqual(state, {
      theme: "workbench", sidebar: "flex", rain: false, promptDisabled: true,
      recentCount: 1, title: "Start a new conversation", version: "v0.0.0-test",
    });
    // The welcome page offers building connection profiles before any workspace
    // is open, alongside the folder picker.
    assert.equal(await evaluate(`(() => {
      const b = document.querySelector('#welcomeSetupConnBtn');
      return Boolean(b) && getComputedStyle(b).display !== 'none';
    })()`), true);
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
    // The "Welcome page" home button shares one row with New conversation (no
    // separate stacked row), is now visible in a session, and carries the crisp
    // SVG house icon rather than a faint glyph.
    const homeRow = await evaluate(`(() => {
      const home = document.querySelector('#navHome');
      const conv = document.querySelector('#navConsole');
      return {
        sameRow: Boolean(home.closest('.sidebar-primary-row')) && home.parentElement === conv.parentElement,
        visible: !home.classList.contains('hidden') && getComputedStyle(home).display !== 'none',
        hasSvgIcon: Boolean(home.querySelector('svg.home-icon')),
        sameTop: Math.abs(home.getBoundingClientRect().top - conv.getBoundingClientRect().top) < 1,
      };
    })()`);
    assert.deepEqual(homeRow, { sameRow: true, visible: true, hasSvgIcon: true, sameTop: true });

    // The topbar's "open the workspace folder" button appears with the workspace
    // and asks main to reveal it — no path leaves the renderer, so main opens the
    // folder of the tab it owns (Explorer / Finder / the Linux file manager).
    assert.equal(await evaluate(`document.querySelector('#revealWorkspaceBtn').classList.contains('hidden')`), false);
    await evaluate(`document.querySelector('#revealWorkspaceBtn').click()`);
    await pause();
    assert.ok(calls.some((c) => c.name === "revealWorkspace" && c.args[0] === null));
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

  await test("the task rail stays live without leaving context", async () => {
    await evaluate(`document.querySelector('#sessionsCloseBtn').click()`);
    await emit({ type: "task_list_updated", tasks: [
      { id: "t1", subject: "Map current UI", status: "completed" },
      { id: "t2", subject: "Implement inspector", status: "in_progress", description: "Wire behavior" },
      { id: "t3", subject: "Verify interactions", status: "pending" },
    ] });
    assert.equal(await evaluate(`document.querySelector('#taskProgress').textContent`), "1/3");
    assert.equal(await evaluate(`document.querySelectorAll('#taskList .task-item').length`), 3);
  });

  await test("attach, model, and composer controls act on runtime state", async () => {
    // Attach button opens the file picker; a readable file becomes a pending chip.
    await evaluate(`document.querySelector('#attachBtn').click()`);
    await pause();
    assert.ok(calls.some((call) => call.name === "pickContextFiles"));
    assert.equal(await evaluate(`document.querySelectorAll('#attachChips .attach-chip').length`), 1);
    // Sending folds the attachment text into the outgoing message beside the prompt.
    await evaluate(`(() => { const input = document.querySelector('#promptInput'); input.value = 'Explain this workspace'; input.dispatchEvent(new Event('input')); input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); })()`);
    await pause();
    assert.ok(frames.some((frame) => frame.type === "user_message" && frame.text.includes("hello from an attached file") && frame.text.includes("Explain this workspace")));
    assert.equal(await evaluate(`document.querySelectorAll('.msg-user').length > 0`), true);
    // Chips clear once the message is sent.
    assert.equal(await evaluate(`document.querySelectorAll('#attachChips .attach-chip').length`), 0);
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
    // Mid-turn plain text steers the running turn immediately — no queue wait.
    await evaluate(`(() => { const input = document.querySelector('#promptInput'); input.value = 'Now verify it'; document.querySelector('#sendBtn').click(); })()`);
    await pause();
    assert.ok(frames.some((frame) => frame.type === "steer_message" && frame.text === "Now verify it"));
    // Commands can't steer, so a slash command typed mid-turn still queues and
    // flushes when the turn ends.
    await evaluate(`(() => { const input = document.querySelector('#promptInput'); input.value = '/help'; document.querySelector('#sendBtn').click(); })()`);
    assert.equal(await evaluate(`document.querySelector('#queueChip').classList.contains('hidden')`), false);
    await evaluate(`document.querySelector('#stopBtn').click()`);
    await pause();
    assert.ok(signals.some((signal) => signal.name === "interrupt"));
    await emit({ type: "turn_finished", contextTokens: 4200, totalCostUsd: 0.012, stopReason: "end_turn" });
    await pause();
    assert.ok(frames.some((frame) => frame.type === "slash_command" && frame.command === "help"));
    assert.match(await evaluate(`document.querySelector('#inspectorUsage').textContent`), /~4\.2k ctx/);
  });

  await test("context counter is approximate, tints past the warn threshold, and shows no price", async () => {
    await emit({ type: "turn_finished", contextTokens: 210000, contextWarn: true, stopReason: "end_turn" });
    await pause();
    let meter = await evaluate(`(() => ({
      text: document.querySelector('#hintUsage').textContent,
      warn: document.querySelector('#hintUsage').classList.contains('warn'),
      inspectorWarn: document.querySelector('#inspectorUsage').classList.contains('warn'),
    }))()`);
    assert.match(meter.text, /ctx ~210k/, "shows a rounded, tilde-prefixed size");
    assert.ok(!meter.text.includes("$"), "never surfaces a price");
    assert.equal(meter.warn, true, "counter tints when the engine flags a large context");
    assert.equal(meter.inspectorWarn, true);
    // Dropping back below the threshold clears the tint.
    await emit({ type: "turn_finished", contextTokens: 5000, contextWarn: false, stopReason: "end_turn" });
    await pause();
    meter = await evaluate(`(() => ({
      text: document.querySelector('#hintUsage').textContent,
      warn: document.querySelector('#hintUsage').classList.contains('warn'),
    }))()`);
    assert.match(meter.text, /ctx ~5\.0k/);
    assert.equal(meter.warn, false);
  });

  await test("the turn's output counter starts at 0, climbs live, and never mixes into the context", async () => {
    // A new turn zeroes the OUTPUT counter. The context counter is untouched —
    // the window did not empty just because a turn began.
    await emit({ type: "turn_started", turnId: "tok1" });
    await pause();
    let live = await evaluate(`(() => ({
      hidden: document.querySelector('#nowTokens').classList.contains('hidden'),
      out: outputTokens, ctx: contextTokens,
      ctxText: document.querySelector('#hintUsage').textContent,
    }))()`);
    assert.equal(live.out, 0, "output starts every turn at zero");
    assert.equal(live.hidden, true, "nothing generated yet — the counter stays out of the way");
    assert.equal(live.ctx, 5000, "a new turn does not reset the context reading");
    assert.match(live.ctxText, /ctx ~5\.0k/);
    // The engine streams the two figures together while it deliberates. Output
    // climbs; the input context of the call in flight does not move with it.
    await emit({ type: "context_update", contextTokens: 5000, outputTokens: 420 });
    await pause();
    live = await evaluate(`(() => ({ text: document.querySelector('#nowTokens').textContent, hidden: document.querySelector('#nowTokens').classList.contains('hidden') }))()`);
    assert.equal(live.hidden, false, "the counter appears as soon as output exists");
    assert.match(live.text, /420 out/);
    await emit({ type: "context_update", contextTokens: 5000, outputTokens: 1400 });
    await pause();
    live = await evaluate(`(() => ({
      text: document.querySelector('#nowTokens').textContent,
      ctxText: document.querySelector('#hintUsage').textContent,
    }))()`);
    assert.match(live.text, /1\.4k out/, "it climbs as the agent works");
    assert.match(live.ctxText, /ctx ~5\.0k/, "output is never added into the context counter");
    // turn_finished carries the turn's exact usage — D_final replaces the estimate.
    await emit({
      type: "turn_finished", turnId: "tok1", stopReason: "end_turn", contextTokens: 5000,
      usage: { inputTokens: 900, outputTokens: 1531, cacheReadTokens: 4100, cacheWriteTokens: 0 },
    });
    await pause();
    const done = await evaluate(`(() => ({
      out: outputTokens, ctx: contextTokens,
      inspector: document.querySelector('#inspectorUsage').textContent,
    }))()`);
    assert.equal(done.out, 1531, "the API's own output total supersedes the live estimate");
    assert.equal(done.ctx, 5000, "cumulative turn usage never becomes the context size");
    assert.match(done.inspector, /~5\.0k ctx · 1\.5k out/, "both figures read side by side, never summed");
    // A compaction frame carries no output figure: absent means unchanged, so
    // the turn's total survives a window that shrank underneath it.
    await emit({ type: "context_update", contextTokens: 2200, contextWarn: false });
    await pause();
    const after = await evaluate(`(() => ({ out: outputTokens, ctxText: document.querySelector('#hintUsage').textContent }))()`);
    assert.equal(after.out, 1531, "an absent outputTokens means unchanged, not zero");
    assert.match(after.ctxText, /ctx ~2\.2k/, "the context counter still adopts the compacted size");
  });

  await test("compaction shows an in-chat indicator, stays out of the jobs chip, and refreshes ctx", async () => {
    // /compact runs outside a turn; the engine brackets it in a background
    // notification. The indicator belongs IN the transcript (professional, no
    // emoji), NOT in the detached-jobs chip under the composer.
    await emit({ type: "background_notification", taskId: "compact", kind: "start", payload: { description: "Compacting conversation", stoppable: false } });
    let state = await evaluate(`(() => ({
      inStream: Boolean(document.querySelector('.stream .compacting')),
      label: (document.querySelector('.compacting-label') || {}).textContent || null,
      hasEmoji: /[\\u{1F000}-\\u{1FAFF}\\u{2300}-\\u{27BF}]/u.test((document.querySelector('.compacting') || {}).textContent || ''),
      jobsChipHidden: document.querySelector('#jobsChip').classList.contains('hidden'),
      working: !document.querySelector('#stopBtn').classList.contains('hidden'),
    }))()`);
    assert.deepEqual(state, {
      inStream: true, label: "Compacting conversation", hasEmoji: false,
      jobsChipHidden: true, working: true,
    }, "compaction indicator lives in the chat, emoji-free, not in the jobs chip");
    // The window shrinks; the engine pushes context_update outside any turn and
    // the bottom-right ctx counter must adopt the fresh number.
    await emit({ type: "context_update", contextTokens: 3300, contextWarn: false });
    await pause();
    assert.match(await evaluate(`document.querySelector('#hintUsage').textContent`), /ctx ~3\.3k/, "ctx counter updates after compaction");
    // Job exit clears the indicator.
    await emit({ type: "background_notification", taskId: "compact", kind: "exit", payload: { description: "Compacting conversation" } });
    state = await evaluate(`(() => ({
      gone: document.querySelector('.compacting') === null,
      idle: document.querySelector('#stopBtn').classList.contains('hidden'),
    }))()`);
    assert.deepEqual(state, { gone: true, idle: true }, "indicator clears and the LED returns to idle when compaction finishes");
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
    // Undoing the last remaining file empties the card entirely. The review
    // drawer is the only undo path now — the inline card's "Undo last" button
    // and its all-sessions counterpart in the inspector are both gone.
    await evaluate(`document.querySelector('#reviewAllBtn').click()`);
    await pause(60);
    await evaluate(`document.querySelector('#reviewUndoBtn').click()`);
    await pause(60);
    assert.equal(await evaluate(`document.querySelector('#inspectorChangesCount').textContent`), "");
    assert.equal(await evaluate(`document.querySelector('.inline-changes-card') === null`), true);
  });

  await test("inline changes card folds past two files and unfolds on demand", async () => {
    const diffFor = (file) => [
      `diff --git a/${file} b/${file}`, "index 5555555..6666666 100644", `--- a/${file}`, `+++ b/${file}`,
      "@@ -1 +1,2 @@", " x", "+y", "",
    ].join("\n");
    for (const file of ["one.js", "two.js", "three.js", "four.js"]) {
      await emit({ type: "file_edited", path: file, diff: diffFor(file) });
    }
    const readCard = `(() => ({
      files: document.querySelectorAll('.inline-changes-list button:not(.inline-changes-more)').length,
      more: (document.querySelector('.inline-changes-more') || {}).textContent || null,
      actions: [...document.querySelectorAll('.inline-changes-actions button')].map((b) => b.textContent),
    }))()`;
    // Compact: two files, the rest behind the fold, and Review changes is the
    // only action left on the card.
    assert.deepEqual(await evaluate(readCard), {
      files: 2, more: "··· 2 more files", actions: ["Review changes"],
    });
    await evaluate(`document.querySelector('.inline-changes-more').click()`);
    assert.deepEqual(await evaluate(readCard), {
      files: 4, more: "··· show less", actions: ["Review changes"],
    });
    // And back — the fold is a toggle, not a one-way reveal.
    await evaluate(`document.querySelector('.inline-changes-more').click()`);
    assert.deepEqual(await evaluate(readCard), {
      files: 2, more: "··· 2 more files", actions: ["Review changes"],
    });
    // Clear the card so the later scenarios see the same transcript they did
    // before this test existed.
    await evaluate(`resetChanges()`);
    assert.equal(await evaluate(`document.querySelector('.inline-changes-card') === null`), true);
  });

  await test("all three themes switch cleanly and only matrix mounts the rain", async () => {
    const readTheme = `(() => ({
      theme: document.documentElement.dataset.theme,
      rain: Boolean(document.querySelector('#matrixRain')),
      bg: getComputedStyle(document.body).backgroundColor,
    }))()`;
    const pick = (name) => `document.querySelector('#setTheme .seg-btn[data-theme="${name}"]').click()`;
    assert.equal(await evaluate(`document.querySelectorAll('#setTheme .seg-btn').length`), 3);

    await evaluate(pick("light"));
    let state = await evaluate(readTheme);
    assert.equal(state.theme, "light");
    assert.equal(state.rain, false);
    const lightBg = state.bg;

    await evaluate(pick("matrix"));
    await pause(60);
    state = await evaluate(readTheme);
    assert.equal(state.theme, "matrix");
    assert.equal(state.rain, true, "matrix theme must mount the rain canvas");
    assert.notEqual(state.bg, lightBg, "matrix must repaint the surface tokens");
    // Decoration only: it must never sit in the accessibility tree or eat clicks.
    assert.equal(await evaluate(`document.querySelector('#matrixRain').getAttribute('aria-hidden')`), "true");
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#matrixRain')).pointerEvents`), "none");

    if (process.env.MAGENTRA_UI_CAPTURE_MATRIX) {
      // Settings view, so the shot covers both the theme and the selector that
      // reaches it. Needs MAGENTRA_UI_CAPTURE set too — that is what shows the
      // window, and a hidden window composites no fresh frames to capture.
      await evaluate(`document.querySelector('#navSettings').click()`);
      await pause(1500); // let the rain build a few frames of trails first
      fs.writeFileSync(process.env.MAGENTRA_UI_CAPTURE_MATRIX, (await windowRef.capturePage()).toPNG());
      await evaluate(`showView('console')`); // back to the transcript for the rest of the suite
      await pause(60);
    }

    // Leaving the theme tears the canvas down rather than hiding it, so no
    // animation frame survives in the other two themes.
    // Rain opacity dial: only present under matrix, drives the canvas opacity,
    // and hides the canvas outright at 0 while staying mounted.
    await evaluate(pick("matrix"));
    await pause(60);
    const readRain = `(() => ({
      rowShown: !document.querySelector('#setRainRow').classList.contains('hidden'),
      field: document.querySelector('#setRainOpacity').value,
      opacity: document.querySelector('#matrixRain') && document.querySelector('#matrixRain').style.opacity,
      saved: JSON.parse(localStorage.getItem('magentra-ui')).rainOpacity,
    }))()`;
    const setRain = (v) => `(() => {
      const el = document.querySelector('#setRainOpacity');
      el.value = '${v}';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`;
    let rain = await evaluate(readRain);
    assert.equal(rain.rowShown, true, "rain dial must be visible under matrix");
    // Ships faint, not full — a legible fraction at the default dial.
    assert.equal(rain.field, "0.35");
    assert.equal(rain.saved, 0.35);
    assert.ok(Number(rain.opacity) > 0 && Number(rain.opacity) < 0.2, "default is faint");

    // Full strength is a fixed base fraction; read it by pinning the dial to 1.
    await evaluate(setRain("1"));
    await pause(60);
    const fullOpacity = Number((await evaluate(readRain)).opacity);
    assert.ok(fullOpacity > 0 && fullOpacity < 1, "full strength is a legible fraction, not 1");

    await evaluate(setRain("0.5"));
    await pause(60);
    rain = await evaluate(readRain);
    assert.equal(rain.saved, 0.5);
    assert.ok(Math.abs(Number(rain.opacity) - fullOpacity * 0.5) < 0.001, "0.5 dial must halve the canvas opacity");

    await evaluate(setRain("0"));
    await pause(60);
    rain = await evaluate(readRain);
    assert.equal(rain.saved, 0);
    assert.equal(Number(rain.opacity), 0, "0 dial hides the rain");
    assert.equal(await evaluate(`Boolean(document.querySelector('#matrixRain'))`), true, "0 keeps the canvas mounted, just invisible");

    // Out of range clamps and rewrites the field.
    await evaluate(setRain("5"));
    await pause(60);
    rain = await evaluate(readRain);
    assert.deepEqual({ field: rain.field, saved: rain.saved }, { field: "1", saved: 1 });
    await evaluate(setRain("1"));
    await pause(60);

    await evaluate(pick("workbench"));
    await pause(60);
    state = await evaluate(readTheme);
    assert.equal(state.theme, "workbench");
    assert.equal(state.rain, false, "leaving matrix must unmount the rain canvas");
    assert.equal(await evaluate(`document.querySelector('#setRainRow').classList.contains('hidden')`), true,
      "rain dial must hide outside matrix");

    // The choice persists like every other UI setting.
    await evaluate(pick("matrix"));
    await pause(60);
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('magentra-ui')).theme`), "matrix");
    await evaluate(pick("workbench"));
    await pause(60);
  });

  await test("UI scale zooms the whole interface, clamps, persists, and resets", async () => {
    await evaluate(`document.querySelector('#navSettings').click()`);
    await pause();
    // Baseline in CSS pixels. Page zoom shrinks the layout viewport, so a
    // scaled-up interface reports a *smaller* innerWidth while the sidebar
    // keeps its 264px token — that ratio is what proves the chrome scaled with
    // the text rather than only the type ramp moving.
    const readScale = `(() => ({
      field: document.querySelector('#setZoom').value,
      saved: JSON.parse(localStorage.getItem('magentra-ui')).zoom,
      viewport: window.innerWidth,
      sidebar: document.querySelector('#sidebar').getBoundingClientRect().width,
    }))()`;
    // Ships at 1.2, so the interface opens gently enlarged.
    assert.equal((await evaluate(readScale)).saved, 1.2);

    const setScale = (v) => `(() => {
      const el = document.querySelector('#setZoom');
      el.value = '${v}';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`;

    // Pin an unzoomed baseline for the breakpoint reasoning below — independent
    // of whatever the ship default happens to be.
    await evaluate(setScale("1"));
    await pause(80);
    const base = await evaluate(readScale);
    assert.equal(base.field, "1");
    assert.equal(base.saved, 1);
    assert.ok(base.viewport > 1120, "test window at 1.0 must start above the widest breakpoint");

    // A gentle scale stays inside the same breakpoint: the viewport shrinks
    // while the sidebar keeps its 264px token, so every pixel of chrome grew
    // by the same factor as the text. That is the whole point of using page
    // zoom over a font-size multiplier — the layout tokens are hard pixels and
    // would not have moved.
    await evaluate(setScale("1.1"));
    await pause(80);
    let state = await evaluate(readScale);
    assert.equal(state.field, "1.1");
    assert.equal(state.saved, 1.1);
    assert.ok(state.viewport < base.viewport, "zooming in must shrink the layout viewport");
    assert.equal(Math.round(state.sidebar), Math.round(base.sidebar));

    // A large scale crosses the responsive breakpoints, and the workbench
    // collapses exactly as it does when the window narrows — the stylesheet's
    // media queries re-evaluate against the scaled viewport for free.
    await evaluate(setScale("1.5"));
    await pause(80);
    state = await evaluate(readScale);
    assert.equal(state.saved, 1.5);
    assert.ok(state.viewport < 1120, "1.5x must drop the viewport past the first breakpoint");
    assert.ok(state.sidebar < base.sidebar, "crossing the breakpoint must collapse the sidebar rail");

    await evaluate(setScale("0.5"));
    await pause(80);
    state = await evaluate(readScale);
    assert.equal(state.saved, 0.5);
    assert.ok(state.viewport > base.viewport, "zooming out must grow the layout viewport");

    // Out of range clamps to the boundary and rewrites the field, so the box
    // never disagrees with the interface it just scaled.
    await evaluate(setScale("7"));
    await pause(80);
    state = await evaluate(readScale);
    assert.deepEqual({ field: state.field, saved: state.saved }, { field: "2", saved: 2 });
    await evaluate(setScale("0.1"));
    await pause(80);
    assert.equal((await evaluate(readScale)).saved, 0.5);
    // Garbage falls back to 1.0 rather than NaN-ing the zoom factor.
    await evaluate(setScale("abc"));
    await pause(80);
    assert.equal((await evaluate(readScale)).saved, 1);

    await evaluate(setScale("1.75"));
    await pause(80);
    await evaluate(`document.querySelector('#setZoomResetBtn').click()`);
    await pause(80);
    state = await evaluate(readScale);
    assert.deepEqual({ field: state.field, saved: state.saved }, { field: "1", saved: 1 });
    assert.equal(state.viewport, base.viewport, "reset must restore the original viewport");

    // Zoom moved outside the setting — what the native View▸Zoom accelerators
    // do — is adopted when the settings view next opens, so the field can
    // never sit at a stale 1.0 over a zoomed interface.
    await evaluate(`showView('console')`);
    await evaluate(`window.magentra.setZoom(1.4)`);
    await pause(80);
    await evaluate(`document.querySelector('#navSettings').click()`);
    await pause(80);
    state = await evaluate(readScale);
    assert.deepEqual({ field: state.field, saved: state.saved }, { field: "1.4", saved: 1.4 });
    // And a factor beyond the supported range snaps back into it.
    await evaluate(`showView('console')`);
    await evaluate(`window.magentra.setZoom(4)`);
    await pause(80);
    await evaluate(`document.querySelector('#navSettings').click()`);
    await pause(80);
    assert.equal((await evaluate(readScale)).saved, 2);

    await evaluate(`document.querySelector('#setZoomResetBtn').click()`);
    await pause(80);
    assert.equal((await evaluate(readScale)).viewport, base.viewport);
    await evaluate(`showView('console')`);
    await pause(60);
  });

  await test("approval and question cards send selected decisions and notes", async () => {
    await emit({ type: "permission_request", id: "p1", description: "Remove generated file", input: { command: "rm generated.js" } });
    assert.equal(await evaluate(`document.querySelector('#deleteModal').classList.contains('hidden')`), false);
    // No subject means nothing durable to grant — "always allow" must stay hidden
    // rather than silently behaving like a one-off allow.
    assert.equal(await evaluate(`document.querySelector('#allowAlwaysBtn').classList.contains('hidden')`), true);
    // A note typed on the card rides out with whatever decision is picked.
    await evaluate(`document.querySelector('#permissionNote').value = 'watch the siblings'`);
    await evaluate(`document.querySelector('#allowBtn').click()`);
    await pause();
    assert.deepEqual(permissions.at(-1), { id: "p1", decision: "allow_once", message: "watch the siblings" });
    // The note field resets before the next card so nothing leaks across prompts.
    assert.equal(await evaluate(`document.querySelector('#permissionNote').value`), "");

    // With a subject, the durable grant is offered and sends allow_always.
    // No note this time — the frame must carry no message. Without a `grant`,
    // the hint promises the EXACT command (deletion-guard prompts).
    await emit({ type: "permission_request", id: "p2", description: "rm -rf ./build", input: { command: "rm -rf ./build" }, subject: "rm -rf ./build" });
    assert.equal(await evaluate(`document.querySelector('#allowAlwaysBtn').classList.contains('hidden')`), false);
    assert.match(await evaluate(`document.querySelector('#allowAlwaysHint').textContent`), /exact command/);
    await evaluate(`document.querySelector('#allowAlwaysBtn').click()`);
    await pause();
    assert.deepEqual(permissions.at(-1), { id: "p2", decision: "allow_always" });

    // With a `grant`, the hint states the command shape the grant will cover.
    await emit({ type: "permission_request", id: "p2a", description: "mkdir -p x", input: { command: "mkdir -p x" }, subject: "mkdir -p x", grant: "mkdir" });
    assert.match(await evaluate(`document.querySelector('#allowAlwaysHint').textContent`), /every “mkdir …” command/);
    await evaluate(`document.querySelector('#allowAlwaysBtn').click()`);
    await pause();
    assert.deepEqual(permissions.at(-1), { id: "p2a", decision: "allow_always" });

    // Fresh card: initial focus must be on the default action, NOT the note
    // textarea — a bare "y" keystroke resolves the card instead of typing.
    await emit({ type: "permission_request", id: "p2b", description: "ls", input: { command: "ls" } });
    assert.equal(await evaluate(`document.activeElement.id`), "allowBtn");
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', bubbles: true }))`);
    await pause();
    assert.deepEqual(permissions.at(-1), { id: "p2b", decision: "allow_once" });

    // Deny carries the note too (the engine folds it into the refusal).
    await emit({ type: "permission_request", id: "p3", description: "drop table users", input: { command: "drop table users" } });
    await evaluate(`document.querySelector('#permissionNote').value = 'use a soft delete instead'`);
    await evaluate(`document.querySelector('#denyBtn').click()`);
    await pause();
    assert.deepEqual(permissions.at(-1), { id: "p3", decision: "deny", message: "use a soft delete instead" });

    await emit({ type: "question_request", questions: [{
      header: "Scope", question: "Which surface?", multiSelect: false,
      options: [{ label: "Workbench (Recommended)", description: "Use Concept A" }, { label: "Legacy", description: "Keep old shell" }],
    }] });
    assert.equal(await evaluate(`document.querySelectorAll('.question-card').length > 0`), true);
    await evaluate(`[...document.querySelectorAll('.question-card')].pop().querySelector('.q-opt').click()`);
    await pause();
    assert.ok(frames.some((frame) => frame.type === "question_response"));
    // Answering closes the card: it is replaced in place by a note recording
    // the question and the choice, so spent options can't be clicked again.
    assert.equal(await evaluate(`document.querySelectorAll('.question-card').length`), 0);
    const answeredNote = await evaluate(`[...document.querySelectorAll('.question-answered')].pop().textContent`);
    assert.match(answeredNote, /User answered Magentra's question/);
    assert.match(answeredNote, /Which surface\?/);
    assert.match(answeredNote, /Workbench/);
  });

  await test("a multi-question round answers every card, and tables render", async () => {
    const questionCountBefore = await evaluate(`document.querySelectorAll('.question-card').length`);
    await emit({ type: "question_request", id: "multi", questions: [
      { header: "One", question: "First?", multiSelect: false, options: [{ label: "1a", description: "" }, { label: "1b", description: "" }] },
      { header: "Two", question: "Second?", multiSelect: false, options: [{ label: "2a", description: "" }, { label: "2b", description: "" }] },
      { header: "Three", question: "Third?", multiSelect: false, options: [{ label: "3a", description: "" }, { label: "3b", description: "" }] },
    ] });
    const cards = await evaluate(`document.querySelectorAll('.question-card').length`);
    assert.equal(cards - questionCountBefore, 3);
    // The engine holds the round open until all three land, so the UI has to
    // say how many remain instead of looking hung after the first answer.
    assert.match(await evaluate(`document.querySelector('.question-progress').textContent`), /0 of 3/);

    // Each answer retires its card, so the round's open cards are always the
    // tail of the transcript — answer the first of however many are left.
    const answerNextCard = (remaining) =>
      evaluate(`[...document.querySelectorAll('.question-card')].slice(-${remaining})[0].querySelector('.q-opt').click()`);
    const responsesBefore = frames.filter((f) => f.type === "question_response").length;
    await answerNextCard(3);
    await pause();
    assert.match(await evaluate(`document.querySelector('.question-progress').textContent`), /1 of 3/);
    await answerNextCard(2);
    await answerNextCard(1);
    await pause();
    // One response per question, each keyed by its own position.
    const responses = frames.filter((f) => f.type === "question_response").slice(responsesBefore);
    assert.equal(responses.length, 3);
    assert.deepEqual(responses.map((r) => Object.keys(r.answers)[0]).sort(), ["q:0", "q:1", "q:2"]);

    // The whole round's UI is gone once it is answered — every card replaced by
    // its note, and the counter (which tracked those cards) removed with them.
    assert.equal(await evaluate(`document.querySelectorAll('.question-card').length`), questionCountBefore);
    assert.equal(await evaluate(`document.querySelector('.question-progress') === null`), true);
    const notes = await evaluate(`[...document.querySelectorAll('.question-answered')].slice(-3).map(e => e.textContent)`);
    assert.equal(notes.length, 3);
    assert.match(notes[0], /User answered Magentra's question · One — “First\?” → “1a”/);
    assert.match(notes[2], /Three — “Third\?” → “3a”/);

    // GFM tables render as real tables once the turn finalizes.
    await emit({ type: "text_delta", text: "Results:\n\n| Setting | Default |\n|---|---:|\n| theme | workbench |\n| deletions | ask |\n" });
    await emit({ type: "turn_finished", contextTokens: 10, totalCostUsd: 0, stopReason: "end_turn" });
    const table = await evaluate(`(() => {
      const t = document.querySelector('.md-table');
      if (!t) return null;
      return {
        wrapped: Boolean(t.closest('.md-table-wrap')),
        headers: [...t.querySelectorAll('thead th')].map(e => e.textContent),
        aligned: t.querySelectorAll('thead th')[1].style.textAlign,
        rows: [...t.querySelectorAll('tbody tr')].map(r => [...r.querySelectorAll('td')].map(c => c.textContent)),
      };
    })()`);
    assert.deepEqual(table, {
      wrapped: true,
      headers: ["Setting", "Default"],
      aligned: "right",
      rows: [["theme", "workbench"], ["deletions", "ask"]],
    });
  });

  await test("markdown renders while streaming, before a question card, and math becomes MathML", async () => {
    // 1. Progressive rendering. A completed block must become real Markdown as
    //    it arrives — waiting for turn_finished left long answers on screen as
    //    raw source for the whole reply.
    await emit({ type: "turn_started" });
    await emit({ type: "text_delta", text: "## Live heading\n\nFirst paragraph.\n\n" });
    const live = await evaluate(`(() => {
      const last = [...document.querySelectorAll('.msg-assistant')].pop();
      const done = last && last.querySelector('.md-done');
      return done && done.querySelector('h2') ? done.querySelector('h2').textContent : null;
    })()`);
    assert.equal(live, "Live heading", "a finished block must render before the turn ends");

    // 2. A half-streamed code fence must NOT be committed early — committing it
    //    would render an unterminated block that changes shape a moment later.
    await emit({ type: "text_delta", text: "```js\nconst a = 1;\n\nconst b = 2;\n" });
    const fenceCommitted = `(() => {
      const last = [...document.querySelectorAll('.msg-assistant')].pop();
      return Boolean(last && last.querySelector('.md-done .md-code'));
    })()`;
    assert.equal(await evaluate(fenceCommitted), false, "an unclosed fence must stay in the live tail");
    await emit({ type: "text_delta", text: "```\n\n" });
    assert.equal(await evaluate(fenceCommitted), true, "the fence renders once it closes");
    await emit({ type: "turn_finished", contextTokens: 10, totalCostUsd: 0, stopReason: "end_turn" });

    // 3. A question card must close the streaming message first, or the text
    //    above it stays raw until the user answers — which is exactly when they
    //    are trying to read it.
    await emit({ type: "turn_started" });
    await emit({ type: "text_delta", text: "# What's the objective?\n\nShip **it**." });
    await emit({ type: "question_request", id: "md-gate", questions: [
      { header: "APPROVE", question: "Approve?", multiSelect: false,
        options: [{ label: "Start work", description: "" }, { label: "Cancel", description: "" }] },
    ] });
    assert.equal(
      await evaluate(`(() => {
        const last = [...document.querySelectorAll('.msg-assistant')].pop();
        return Boolean(last && last.querySelector('h1') && last.querySelector('strong'));
      })()`),
      true,
      "markdown must be rendered before the approval card, not after it is answered",
    );

    // 4. Math. Rendered as native MathML — no library, no web font, nothing the
    //    strict CSP would block.
    await emit({ type: "text_delta", text: "\n\nInline $E = mc^2$ and a block:\n\n$$\\frac{a}{b} + \\sqrt{x}$$\n\n" });
    await emit({ type: "turn_finished", contextTokens: 10, totalCostUsd: 0, stopReason: "end_turn" });
    const math = await evaluate(`(() => {
      const nodes = [...document.querySelectorAll('math')];
      if (nodes.length < 2) return { count: nodes.length };
      const inline = nodes[nodes.length - 2];
      const block = nodes[nodes.length - 1];
      return {
        count: nodes.length,
        ns: inline.namespaceURI,
        inlineDisplay: inline.getAttribute('display'),
        sup: inline.querySelector('msup') !== null,
        blockDisplay: block.getAttribute('display'),
        frac: block.querySelector('mfrac') !== null,
        sqrt: block.querySelector('msqrt') !== null,
        wrapped: Boolean(block.closest('.md-math-wrap')),
      };
    })()`);
    assert.equal(math.ns, "http://www.w3.org/1998/Math/MathML", "math must be real MathML, not styled HTML");
    assert.equal(math.inlineDisplay, "inline");
    assert.equal(math.sup, true, "E = mc^2 needs a superscript");
    assert.equal(math.blockDisplay, "block");
    assert.equal(math.frac, true, "\\frac must become <mfrac>");
    assert.equal(math.sqrt, true, "\\sqrt must become <msqrt>");
    assert.equal(math.wrapped, true, "a wide formula scrolls in its own strip");

    // 5. Money is not mathematics. "$5 ... $7" must survive as plain text, or
    //    every price in a reply turns into a formula.
    await emit({ type: "turn_started" });
    await emit({ type: "text_delta", text: "It costs $5, not $7 — and `$x$` stays literal." });
    await emit({ type: "turn_finished", contextTokens: 10, totalCostUsd: 0, stopReason: "end_turn" });
    const prices = await evaluate(`(() => {
      const last = [...document.querySelectorAll('.msg-assistant')].pop();
      return { math: last.querySelectorAll('math').length, text: last.textContent };
    })()`);
    assert.equal(prices.math, 0, "prices and backticked $x$ must not render as math");
    assert.match(prices.text, /\$5, not \$7/);
  });

  await test("skills view, chips, recommended set, and create-skill wizard are functional", async () => {
    await emit({ type: "modes_updated", modes: [
      { id: "reshape", name: "Reshape", description: "Deliberate restructuring", why: "Enable for large refactors", active: false, recommended: false, conflicts: [] },
      { id: "prover", name: "Prover", description: "Prove every change", why: "Enable when correctness matters", active: false, recommended: true, conflicts: [] },
    ] });
    // No hero quick-toggle chips ship by default now (the built-in skills were
    // retired for the Addon redesign) — only the summary chip renders.
    assert.equal(await evaluate(`document.querySelectorAll('.mode-chip.hero').length`), 0);
    // The summary chip opens the Skills view; both fixture cards render with badges + why.
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
    // Every card has an export button. It asks the engine for the .md
    // (export_skill), and on the reply saves it via main (saveSkillExport) — so
    // built-ins export too, not only on-disk skills.
    assert.equal(await evaluate(`document.querySelectorAll('.skill-export-btn').length`), 2);
    await evaluate(`[...document.querySelectorAll('.skill-card')].find((c) => c.querySelector('.skill-name').textContent === 'Prover').querySelector('.skill-export-btn').click()`);
    await pause();
    assert.ok(frames.some((frame) => frame.type === "export_skill" && frame.id === "prover"));
    await emit({ type: "skill_export", ok: true, id: "prover", filename: "prover.md", text: "---\\nkind: discipline\\nname: Prover\\n---\\n\\nProve it." });
    await pause();
    assert.ok(calls.some((call) => call.name === "saveSkillExport" && call.args[0].filename === "prover.md"));
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
    // Create-skill wizard: describe → generateSkill (main resolves any profile)
    // → draft preview → install_skill frame. Reachable from Settings too.
    await evaluate(`document.querySelector('#skillCreateBtn').click()`);
    assert.equal(await evaluate(`document.querySelector('#skillWizard').classList.contains('hidden')`), false);
    // The "author with" model picker is populated (no enforcement UI any more).
    assert.ok(await evaluate(`document.querySelectorAll('#skillModelSelect option').length > 0`), "the author-with model picker is populated");
    await evaluate(`(() => {
      document.querySelector('#skillDescInput').value = 'Always write rollback SQL beside every migration';
      document.querySelector('#skillContextInput').value = 'when editing files under db/migrations';
      document.querySelector('#skillWizGenerate').click();
    })()`);
    await pause();
    const genCall = calls.filter((call) => call.name === "generateSkill").pop();
    assert.equal(genCall.args[0].kind, "discipline");
    assert.equal(genCall.args[0].context, "when editing files under db/migrations");
    assert.ok(genCall.args[0].model, "the chosen author model rides along");
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
    // The auto-compact limit is UI-set and pushed to the engine as set_compact_limit.
    await evaluate(`(() => { const el = document.querySelector('#setCompactLimit'); el.value = '80000'; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await pause();
    assert.ok(frames.some((frame) => frame.type === "set_compact_limit" && frame.limit === 80000), "UI limit rides to the engine");
    // 0 turns it off; a tiny value floors to keep it usable.
    await evaluate(`(() => { const el = document.querySelector('#setCompactLimit'); el.value = '0'; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await pause();
    assert.ok(frames.some((frame) => frame.type === "set_compact_limit" && frame.limit === 0));
    assert.equal(await evaluate(`document.querySelector('#setCompactLimit').value`), "0");
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
    await pause(80);
    assert.equal(await evaluate(`document.querySelector('#setupWizard').classList.contains('hidden')`), false);
    await evaluate(`(() => {
      document.querySelector('#wizName').value = 'My Endpoint';
      const base = document.querySelector('#wizBaseUrl');
      base.value = 'https://api.test/v1';
      base.dispatchEvent(new Event('input'));
      const model = document.querySelector('#wizModel');
      model.value = 'deepseek-ai/DeepSeek-V4-Flash';
      model.dispatchEvent(new Event('input'));
      document.querySelector('#wizApiKey').value = 'wizard-test-key';
      document.querySelector('#wizApiKey').dispatchEvent(new Event('input'));
      document.querySelector('#wizTestBtn').click();
    })()`);
    await pause();
    assert.equal(await evaluate(`document.querySelector('#wizStatus').textContent`), "link established");
    // SAVE & CONNECT saves the profile globally, then applies it to the workspace.
    await evaluate(`document.querySelector('#wizStartBtn').click()`);
    await pause();
    const savedProfile = calls.filter((call) => call.name === "saveProfile").pop();
    assert.equal(savedProfile.args[0].name, "My Endpoint");
    assert.ok(calls.some((call) => call.name === "applyProfile"));
    assert.equal(await evaluate(`document.querySelector('#setupWizard').classList.contains('hidden')`), true);
  });

  await test("custom endpoint wizard: pasted URL normalizes, keyless + self-signed works, model stays aligned", async () => {
    windowRef.webContents.send("test:setup-required", { workspace: WORKSPACE });
    await pause(80);
    // Presets are just Custom / Ollama / LM Studio — no provider branding — and
    // the local servers are auto-detected: Ollama enabled, LM Studio grayed out
    // with a hover reason.
    let detect = await evaluate(`(() => ({
      presets: [...document.querySelectorAll('.wiz-preset')].map((b) => b.dataset.preset),
      ollamaDisabled: document.querySelector('[data-preset="ollama"]').disabled,
      lmDisabled: document.querySelector('[data-preset="lmstudio"]').disabled,
      lmTitle: document.querySelector('[data-preset="lmstudio"]').title,
    }))()`);
    assert.deepEqual(detect.presets, ["custom", "ollama", "lmstudio"]);
    assert.equal(detect.ollamaDisabled, false);
    assert.equal(detect.lmDisabled, true);
    assert.match(detect.lmTitle, /LM Studio/);
    await evaluate(`document.querySelector('[data-preset="custom"]').click()`);
    let state = await evaluate(`(() => ({
      insecureVisible: !document.querySelector('#wizInsecureRow').hidden,
      hintVisible: !document.querySelector('#wizBaseUrlHint').hidden,
    }))()`);
    assert.deepEqual(state, { insecureVisible: true, hintVisible: true });
    // Paste the full completions URL a script would use, keyless, self-signed.
    await evaluate(`(() => {
      document.querySelector('#wizName').value = 'Coder GW';
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
    // SAVE & CONNECT proceeds keyless without an "untested" warning (TEST passed);
    // the saved profile carries the normalized base, model, and TLS opt-in.
    await evaluate(`document.querySelector('#wizStartBtn').click()`);
    await pause();
    const saveCall = calls.filter((c) => c.name === "saveProfile").pop();
    assert.equal(saveCall.args[0].name, "Coder GW");
    assert.equal(saveCall.args[0].insecureTls, true);
    assert.equal(saveCall.args[0].baseUrl, "https://gw.example/coder/v1");
    assert.equal(saveCall.args[0].model, "qwen3.6-35b-a3b");
    assert.ok(calls.some((c) => c.name === "applyProfile"));
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

  await test("connection profiles: dock opens the picker, USE applies, delete removes", async () => {
    // The two wizard scenarios above saved "My Endpoint" and "Coder GW".
    const dockCount = await evaluate(`document.querySelectorAll('#dock .dock-btn').length`);
    // The Connect button sits immediately left of Settings.
    const order = await evaluate(`(() => {
      const btns = [...document.querySelectorAll('#dock .dock-btn')].map((b) => b.id);
      return { connectBeforeSettings: btns.indexOf('navSetupConn') === btns.indexOf('navSettings') - 1 };
    })()`);
    assert.equal(order.connectBeforeSettings, true);
    assert.ok(dockCount >= 2);

    // Open the connections wizard from the dock (a workspace is open → apply mode).
    await evaluate(`document.querySelector('#navSetupConn').click()`);
    await pause(80);
    let state = await evaluate(`(() => ({
      open: !document.querySelector('#setupWizard').classList.contains('hidden'),
      rows: document.querySelectorAll('#wizProfilesList .wiz-profile-row').length,
      useButtons: document.querySelectorAll('.wiz-profile-use').length,
      names: [...document.querySelectorAll('.wiz-profile-name')].map((n) => n.textContent),
    }))()`);
    assert.equal(state.open, true);
    assert.equal(state.rows, 2);
    assert.equal(state.useButtons, 2, "USE is offered in apply mode");
    assert.ok(state.names.includes("My Endpoint") && state.names.includes("Coder GW"));

    // Clicking a profile loads it for editing with a blank key field; TEST must
    // then point main at the stored key by id (not send an empty key → 401).
    await evaluate(`document.querySelector('.wiz-profile-info').click()`);
    await pause();
    assert.equal(await evaluate(`document.querySelector('#wizApiKey').value`), "", "loaded profile leaves the key blank");
    await evaluate(`document.querySelector('#wizTestBtn').click()`);
    await pause();
    const profileTest = calls.filter((c) => c.name === "testConnection").pop();
    assert.ok(profileTest.args[0].profileId, "TEST forwards the profile id so main can use the stored key");
    // Re-open cleanly for the USE/delete flow (editing state was just set).
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
    await pause();
    await evaluate(`document.querySelector('#navSetupConn').click()`);
    await pause(80);

    // USE applies that profile and closes the wizard.
    await evaluate(`document.querySelector('.wiz-profile-use').click()`);
    await pause();
    assert.ok(calls.some((c) => c.name === "applyProfile" && typeof c.args[0] === "string"));
    assert.equal(await evaluate(`document.querySelector('#setupWizard').classList.contains('hidden')`), true);

    // Reopen and delete a profile — the row disappears and the store shrinks.
    await evaluate(`document.querySelector('#navSetupConn').click()`);
    await pause(80);
    await evaluate(`document.querySelector('.wiz-profile-del').click()`);
    await pause();
    assert.ok(calls.some((c) => c.name === "deleteProfile"));
    assert.equal(await evaluate(`document.querySelectorAll('#wizProfilesList .wiz-profile-row').length`), 1);
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
    assert.equal(await evaluate(`document.querySelector('#setupWizard').classList.contains('hidden')`), true);
    // USE left the engine unlinked (awaiting the new connection); relink for the
    // remaining scenarios exactly as a real session_started would.
    await emit({ type: "session_started", sessionId: "sess-prof", model: MODEL, commands: [], rateCard: {} });
  });

  await test("connection profiles: consecutive saves accumulate, never overwrite", async () => {
    await evaluate(`document.querySelector('#navSetupConn').click()`);
    await pause(80);
    const before = await evaluate(`document.querySelectorAll('#wizProfilesList .wiz-profile-row').length`);
    const buildAndSave = (name) => `(() => {
      document.querySelector('#wizName').value = '${name}';
      const base = document.querySelector('#wizBaseUrl');
      base.value = 'https://api.test/v1';
      base.dispatchEvent(new Event('input'));
      const model = document.querySelector('#wizModel');
      model.value = 'some/model';
      model.dispatchEvent(new Event('input'));
      document.querySelector('#wizSaveProfileBtn').click();
    })()`;
    await evaluate(buildAndSave("Alpha"));
    await pause();
    // The form resets after a save, so the next SAVE PROFILE builds a NEW one.
    assert.equal(await evaluate(`document.querySelector('#wizName').value`), "");
    await evaluate(buildAndSave("Beta"));
    await pause();
    const after = await evaluate(`(() => ({
      rows: document.querySelectorAll('#wizProfilesList .wiz-profile-row').length,
      names: [...document.querySelectorAll('.wiz-profile-name')].map((n) => n.textContent),
    }))()`);
    assert.equal(after.rows, before + 2, "each save adds a distinct profile");
    assert.ok(after.names.includes("Alpha") && after.names.includes("Beta"), "the first save must survive the second");
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
  });

  await test("Esc closes an open stage view back to the console", async () => {
    await evaluate(`document.querySelector('#navSettings').click()`);
    await pause();
    assert.equal(await evaluate(`document.body.dataset.view`), "settings");
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
    await pause();
    assert.equal(await evaluate(`document.body.dataset.view`), "console");
  });

  await test("session report opens as a line-by-line modal and Esc closes it", async () => {
    const report =
      "Session\n\n" +
      "  Total duration (API):  3s\n" +
      "  Context now:            ~10.7k tokens\n" +
      "  Context breakdown (~estimated):\n" +
      "      System prompt:  ~3.3k tokens\n" +
      "      Free space:     ~53.3k tokens (until auto-compact at ~64.0k)\n" +
      "  Skills loaded:         0\n" +
      "  Disciplines active:    0 of 9";
    await emit({ type: "session_report", text: report });
    const state = await evaluate(`(() => ({
      open: !document.querySelector('#sessionModal').classList.contains('hidden'),
      rows: document.querySelectorAll('#sessionModalBody .sr-line').length,
      keys: [...document.querySelectorAll('#sessionModalBody .sr-key')].map(e => e.textContent),
      hasHooks: document.querySelector('#sessionModalBody').textContent.toLowerCase().includes('hook'),
      hasMcp: document.querySelector('#sessionModalBody').textContent.toLowerCase().includes('mcp'),
    }))()`);
    assert.equal(state.open, true, "modal should open on session_report");
    assert.ok(state.rows >= 6, `expected multiple rows, got ${state.rows}`);
    assert.ok(state.keys.includes("Context now:"), "should split label/value rows");
    assert.equal(state.hasHooks, false, "must not surface hooks stats");
    assert.equal(state.hasMcp, false, "must not surface MCP stats");
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
    await pause();
    assert.equal(await evaluate(`document.querySelector('#sessionModal').classList.contains('hidden')`), true, "Esc should close the modal");
  });

  // Full screen removes the native title bar (on Windows the controls overlay
  // with it), which once left no visible way out of full screen at all.
  await test("full screen reveals in-app window controls that minimize, restore, and close", async () => {
    assert.equal(
      await evaluate(`document.querySelector('#windowControls').classList.contains('hidden')`),
      true,
      "windowed: the native title bar is there, so the app draws none",
    );
    windowRef.webContents.send("test:fullscreen", true);
    await pause(60);
    assert.equal(
      await evaluate(`document.querySelector('#windowControls').classList.contains('hidden')`),
      false,
      "full screen: the app's own window buttons stand in",
    );
    const before = signals.length;
    await evaluate(`(() => {
      document.querySelector('#winMinimizeBtn').click();
      document.querySelector('#winFullScreenBtn').click();
      document.querySelector('#winCloseBtn').click();
    })()`);
    await pause(60);
    assert.deepEqual(
      signals.slice(before).map((s) => s.value),
      ["minimize", "toggleFullScreen", "close"],
      "each button drives its own window action",
    );
    // The menu item is the second way out — it must fire the same action.
    await evaluate(`document.querySelector('#menuBar .menu-root').click()`);
    await pause(60);
    await evaluate(`[...document.querySelectorAll('.menu-item')].find((b) => b.textContent.startsWith('Toggle Full Screen')).click()`);
    await pause(60);
    assert.equal(signals[signals.length - 1].value, "toggleFullScreen", "VIEW → Toggle Full Screen leaves full screen");
    windowRef.webContents.send("test:fullscreen", false);
    await pause(60);
    assert.equal(
      await evaluate(`document.querySelector('#windowControls').classList.contains('hidden')`),
      true,
      "back in a window, the native buttons are back — hide ours",
    );
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

  await test("concurrent tabs: auto-tile, per-pane input, stream isolation, close returns", async () => {
    windowRef.setSize(1280, 800);
    await pause(60);
    const tabEvt = (ch, p) => windowRef.webContents.send(ch, p);
    const started = (sessionId, cwd, tabId) => ({
      type: "session_started", v: 1, sessionId, cwd, model: MODEL,
      overdrive: false, commands: [], rateCard: {}, tabId,
    });
    // Open tab A (main-driven), stream some visible text into it.
    tabEvt("test:tab-opened", { tabId: "tA", workspace: "/tmp/ws-a" });
    await emit({ type: "workspace_changed", workspace: "/tmp/ws-a", tabId: "tA" });
    await emit(started("sA", "/tmp/ws-a", "tA"));
    await emit({ type: "turn_started", turnId: "tnA", tabId: "tA" });
    await emit({ type: "text_delta", text: "ALPHA-visible", tabId: "tA" });
    // Open tab B — reaching two tabs AUTO-TILES into a grid (no toggle).
    tabEvt("test:tab-opened", { tabId: "tB", workspace: "/tmp/ws-b" });
    await emit({ type: "workspace_changed", workspace: "/tmp/ws-b", tabId: "tB" });
    await emit(started("sB", "/tmp/ws-b", "tB"));
    await emit({ type: "text_delta", text: "BETA-visible", tabId: "tB" });
    // A background event for A: it must render into A's OWN stream/pane, never
    // leaking into B's.
    await emit({ type: "text_delta", text: "ALPHA-bg", tabId: "tA" });
    await pause(40);
    const t = await evaluate(`(() => ({
      focused: focusedTabId, tabCount: tabs.size,
      grid: document.querySelector('#transcript').classList.contains('console-grid'),
      panes: document.querySelector('#transcript').getAttribute('data-panes'),
      paneEls: document.querySelectorAll('.console-pane').length,
      paneInputs: document.querySelectorAll('.console-pane .pane-input').length,
      composerHidden: document.body.classList.contains('tiled'),
      aHasAlpha: tabs.get('tA').streamEl.textContent.includes('ALPHA-visible') && tabs.get('tA').streamEl.textContent.includes('ALPHA-bg'),
      aNoBeta: !tabs.get('tA').streamEl.textContent.includes('BETA'),
      bHasBeta: tabs.get('tB').streamEl.textContent.includes('BETA-visible'),
      bNoAlpha: !tabs.get('tB').streamEl.textContent.includes('ALPHA'),
    }))()`);
    assert.equal(t.focused, "tB");
    assert.equal(t.tabCount, 2);
    assert.equal(t.grid, true, "two tabs auto-tile into a grid — no toggle");
    assert.equal(t.panes, "2", "two panes for two tabs");
    assert.equal(t.paneEls, 2, "both consoles tiled as panes");
    assert.equal(t.paneInputs, 2, "each pane has its own message input");
    assert.ok(t.composerHidden, "the shared bottom composer gives way to per-pane inputs");
    assert.ok(t.aHasAlpha, "tab A's stream holds its own foreground + background text");
    assert.ok(t.aNoBeta, "tab B's text never leaks into tab A's pane");
    assert.ok(t.bHasBeta, "tab B's stream holds its own text");
    assert.ok(t.bNoAlpha, "tab A's text never leaks into tab B's pane");
    // Token meters under tiling: each pane counts its OWN turn's output, and the
    // top bar carries the input context added up across every open workspace.
    await emit({ type: "turn_started", turnId: "tnB", tabId: "tB" });
    await emit({ type: "context_update", contextTokens: 24000, outputTokens: 900, tabId: "tA" });
    await emit({ type: "context_update", contextTokens: 6000, outputTokens: 150, tabId: "tB" });
    await pause(40);
    const meters = await evaluate(`(() => ({
      aOut: tabs.get('tA').paneEl.querySelector('.pane-now-tokens').textContent,
      bOut: tabs.get('tB').paneEl.querySelector('.pane-now-tokens').textContent,
      topHidden: document.querySelector('#ctxMeter').classList.contains('hidden'),
      top: document.querySelector('#ctxMeterValue').textContent,
      composerHidden: document.querySelector('#composer').offsetParent === null,
    }))()`);
    assert.match(meters.aOut, /900 out/, "each pane counts its own workspace's output");
    assert.match(meters.bOut, /150 out/, "a second workspace counts its own, not the first's");
    assert.equal(meters.topHidden, false, "tiling moves the context total up to the top bar");
    assert.equal(meters.top, "~30k", "the top bar sums the input context of every open workspace");
    assert.ok(meters.composerHidden, "the bottom counter's composer is not on screen while tiled");
    // Focus tab A: its pane gains the focus ring; both panes stay visible.
    tabEvt("test:tab-focused", { tabId: "tA" });
    await pause(40);
    const foc = await evaluate(`(() => ({
      focused: focusedTabId,
      aFocused: tabs.get('tA').paneEl.classList.contains('focused'),
      bNotFocused: !tabs.get('tB').paneEl.classList.contains('focused'),
    }))()`);
    assert.equal(foc.focused, "tA");
    assert.ok(foc.aFocused, "clicking/focusing a pane rings it");
    assert.ok(foc.bNotFocused, "only the focused pane is ringed");
    // Each pane header carries its own "open the workspace folder" button, and it
    // names ITS tab — a background pane must reveal its own workspace, not the
    // focused one's.
    await evaluate(`tabs.get('tB').paneEl.querySelector('.pane-reveal-btn').click()`);
    await pause();
    assert.ok(calls.some((c) => c.name === "revealWorkspace" && c.args[0] === "tB"));
    // OVERDRIVE on a tiled screen must read exactly as it does in a single
    // console: the pane's MESSAGE BOX goes hot, the pane's own outline (which
    // means "focused" / "needs approval") is left alone, and the engage sweep
    // plays inside that screen only.
    const beforeOd = await evaluate(`(() => {
      const b = tabs.get('tB').paneEl;
      return { edge: getComputedStyle(b).borderTopColor, input: getComputedStyle(b.querySelector('.pane-input')).borderTopColor };
    })()`);
    const odFramesBefore = frames.filter((f) => f.type === "set_overdrive").length;
    await evaluate(`tabs.get('tB').paneEl.querySelector('.pane-od-btn').click()`);
    await pause(40);
    const od = await evaluate(`(() => {
      const b = tabs.get('tB').paneEl, a = tabs.get('tA').paneEl;
      const cin = b.querySelector(':scope > .overdrive-cinematic');
      return {
        bOn: b.classList.contains('overdrive'),
        aOff: !a.classList.contains('overdrive'),
        edge: getComputedStyle(b).borderTopColor,
        input: getComputedStyle(b.querySelector('.pane-input')).borderTopColor,
        cinematicPlaying: Boolean(cin) && cin.classList.contains('in-pane') && cin.classList.contains('playing'),
        cinematicScoped: Boolean(cin) && cin.parentElement === b,
        aNoCinematic: !a.querySelector(':scope > .overdrive-cinematic'),
        inputClass: b.querySelector('.pane-input').classList.value,
      };
    })()`);
    assert.ok(od.bOn, "the pane button engages OVERDRIVE for its own workspace");
    assert.ok(od.aOff, "one screen's OVERDRIVE never spreads to another");
    assert.equal(od.edge, beforeOd.edge, "the pane outline keeps meaning focus, not OVERDRIVE");
    assert.match(od.inputClass, /\boverdrive\b/, "the pane's message box is what carries the hot line");
    assert.ok(od.cinematicPlaying, "the engage sweep plays, bounded by the pane");
    assert.ok(od.cinematicScoped, "the sweep is a child of the engaging pane, not the window");
    assert.ok(od.aNoCinematic, "no other screen plays it");
    // The hot line itself, read once the sweep has finished: while its veil
    // animates over the pane, Chromium serves that subtree's older computed
    // style, so measuring mid-sweep reads the pre-OVERDRIVE border.
    await pause(2300);
    const painted = await evaluate(`(() => {
      const b = tabs.get('tB').paneEl, a = tabs.get('tA').paneEl;
      return { hot: getComputedStyle(b.querySelector('.pane-input')).borderTopColor,
               plain: getComputedStyle(a.querySelector('.pane-input')).borderTopColor,
               edge: getComputedStyle(b).borderTopColor };
    })()`);
    assert.match(painted.hot, /^rgba\(255, 140, 26/, "the message box carries the OVERDRIVE hue");
    assert.notEqual(painted.plain, painted.hot, "a screen not in OVERDRIVE keeps the plain box");
    assert.equal(painted.edge, beforeOd.edge, "and the pane outline never took the hue");
    const odFrame = frames.filter((f) => f.type === "set_overdrive").pop();
    assert.equal(frames.filter((f) => f.type === "set_overdrive").length - odFramesBefore, 1);
    assert.equal(odFrame.enabled, true);
    // Open a 3rd tab → 3-pane layout; the big (bottom) pane defaults to the last.
    tabEvt("test:tab-opened", { tabId: "tC", workspace: "/tmp/ws-c" });
    await emit({ type: "workspace_changed", workspace: "/tmp/ws-c", tabId: "tC" });
    await emit(started("sC", "/tmp/ws-c", "tC"));
    // Give the focused tab (tC) some skills so the pane menu can list them.
    await emit({ type: "modes_updated", modes: [{ id: "grill", name: "The Grill", description: "d", active: false, builtin: true }], tabId: "tC" });
    await pause(40);
    const three = await evaluate(`(() => ({
      panes: document.querySelector('#transcript').getAttribute('data-panes'),
      cBig: tabs.get('tC').paneEl.classList.contains('pane-big'),
      aBig: tabs.get('tA').paneEl.classList.contains('pane-big'),
    }))()`);
    assert.equal(three.panes, "3", "three tabs → 3-pane layout");
    assert.ok(three.cBig, "the big bottom pane defaults to the 3rd/last-opened tab");
    assert.ok(!three.aBig, "a top pane is not big by default");
    // Right-click tab C's header (it is the focused tab, so it has the skills).
    await evaluate(`(() => {
      const head = tabs.get('tC').paneEl.querySelector('.console-pane-head');
      head.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }));
    })()`);
    await pause(30);
    const menu = await evaluate(`(() => ({
      open: !!document.querySelector('.ctx-menu'),
      hasClose: [...document.querySelectorAll('.ctx-item')].some(b => b.textContent.includes('CLOSE TAB')),
      hasSkillCheckbox: !!document.querySelector('.ctx-menu .ctx-check input[data-skill="grill"]'),
      hasMoveToBottom: [...document.querySelectorAll('.ctx-item')].some(b => b.textContent.includes('MOVE TO BOTTOM')),
    }))()`);
    assert.ok(menu.open, "right-click a pane header opens its menu");
    assert.ok(menu.hasClose, "the pane menu offers Close Tab");
    assert.ok(menu.hasSkillCheckbox, "the pane menu lists this workspace's skills as checkboxes");
    // tC is already the big pane, so it offers no "move to bottom"; right-click a TOP pane.
    assert.ok(!menu.hasMoveToBottom, "the big pane has no move-to-bottom");
    await evaluate(`document.querySelector('.ctx-menu') && document.body.click()`); // close menu
    await pause(20);
    await evaluate(`(() => {
      const head = tabs.get('tA').paneEl.querySelector('.console-pane-head');
      head.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 60 }));
    })()`);
    await pause(30);
    await evaluate(`[...document.querySelectorAll('.ctx-item')].find(b => b.textContent.includes('MOVE TO BOTTOM')).click()`);
    await pause(40);
    const moved = await evaluate(`(() => ({ aBig: tabs.get('tA').paneEl.classList.contains('pane-big'), cBig: tabs.get('tC').paneEl.classList.contains('pane-big') }))()`);
    assert.ok(moved.aBig, "move-to-bottom promotes the chosen pane to the big slot");
    assert.ok(!moved.cBig, "the previous big pane is demoted");
    // Background jobs must render into the OWNING pane, each with its own STOP —
    // a job on a BACKGROUND tab (focused is tC) must land in that tab's pane, not
    // the focused one (the bug: only the first pane showed).
    await emit({ type: "background_notification", taskId: "job-a", kind: "start", payload: { description: "server :3000", stoppable: true }, tabId: "tA" });
    await emit({ type: "background_notification", taskId: "job-b", kind: "start", payload: { description: "server :4000", stoppable: true }, tabId: "tB" });
    await pause(40);
    const jobs = await evaluate(`(() => {
      const g = (id) => tabs.get(id).paneEl.querySelector('.pane-jobs');
      const a = g('tA'), b = g('tB'), c = g('tC');
      return {
        aText: a.textContent, aStop: !!a.querySelector('.job-stop'), aShown: !a.classList.contains('hidden'),
        bText: b.textContent, bStop: !!b.querySelector('.job-stop'), bShown: !b.classList.contains('hidden'),
        cShown: !c.classList.contains('hidden'),
      };
    })()`);
    assert.ok(jobs.aText.includes('server :3000') && jobs.aStop && jobs.aShown, "tab A's pane shows its own background job + STOP");
    assert.ok(jobs.bText.includes('server :4000') && jobs.bStop && jobs.bShown, "tab B's pane shows its OWN job (not just the first pane)");
    assert.ok(!jobs.aText.includes('4000') && !jobs.bText.includes('3000'), "a pane's jobs never leak into another pane");
    assert.ok(!jobs.cShown, "a pane with no background job shows no jobs chip");
    await emit({ type: "background_notification", taskId: "job-a", kind: "exit", tabId: "tA" });
    await emit({ type: "background_notification", taskId: "job-b", kind: "exit", tabId: "tB" });
    await pause(20);
    // Close C → back to two panes, then continue to the single-tab close below.
    tabEvt("test:tab-closed", { tabId: "tC", focus: "tA" });
    tabEvt("test:tab-focused", { tabId: "tA" });
    await pause(40);
    // Close B: back down to one tab → single view (no grid, shared composer back).
    tabEvt("test:tab-closed", { tabId: "tB", focus: "tA" });
    tabEvt("test:tab-focused", { tabId: "tA" });
    await pause(40);
    const closed = await evaluate(`({ tabCount: tabs.size, focused: focusedTabId, rows: document.querySelectorAll('.sidebar-tab-row').length, grid: document.querySelector('#transcript').classList.contains('console-grid'), tiled: document.body.classList.contains('tiled') })`);
    assert.equal(closed.grid, false, "back to a single console when one tab remains");
    assert.equal(closed.tiled, false, "the shared composer returns");
    assert.equal(closed.tabCount, 1);
    assert.equal(closed.focused, "tA");
    assert.equal(closed.rows, 1);
    // Re-tile after a close must not leave a stray console from the closed tab:
    // add content to the kept tab, then re-open a tab (the exact repro that left
    // an orphan dead stream as an extra grid child and "bugged out").
    await emit({ type: "text_delta", text: "ALPHA-after-close", tabId: "tA" });
    await pause(20);
    tabEvt("test:tab-opened", { tabId: "tB2", workspace: "/tmp/ws-b" });
    await emit({ type: "workspace_changed", workspace: "/tmp/ws-b", tabId: "tB2" });
    await emit(started("sB2", "/tmp/ws-b", "tB2"));
    await pause(40);
    const retile = await evaluate(`({
      tabCount: tabs.size,
      panes: document.querySelector('#transcript').getAttribute('data-panes'),
      paneEls: document.querySelectorAll('#transcript > .console-pane').length,
      strayStreams: document.querySelectorAll('#transcript > .stream').length,
      aKept: tabs.get('tA').streamEl.textContent.includes('ALPHA-after-close'),
    })`);
    assert.equal(retile.tabCount, 2, "re-opening a tab after a close tiles two again");
    assert.equal(retile.panes, "2");
    assert.equal(retile.paneEls, 2, "exactly two panes — no orphan pane from the closed tab");
    assert.equal(retile.strayStreams, 0, "no stray dead stream left directly under #transcript");
    assert.ok(retile.aKept, "the kept tab's content survives the re-tile");
    // Now close the FOCUSED tab (tB2) — the stale-globals path — and confirm the
    // kept tab returns cleanly with no strays.
    tabEvt("test:tab-closed", { tabId: "tB2", focus: "tA" });
    tabEvt("test:tab-focused", { tabId: "tA" });
    await pause(40);
    const afterFocusedClose = await evaluate(`({
      tabCount: tabs.size, tiled: document.body.classList.contains('tiled'),
      directStreams: document.querySelectorAll('#transcript > .stream').length,
      panes: document.querySelectorAll('#transcript > .console-pane').length,
      shownIsA: document.querySelector('#transcript > .stream') === tabs.get('tA').streamEl,
      transcriptHasA: document.querySelector('#transcript').textContent.includes('ALPHA-after-close'),
    })`);
    assert.equal(afterFocusedClose.tabCount, 1);
    assert.equal(afterFocusedClose.tiled, false, "closing the focused tab returns to a single console");
    assert.equal(afterFocusedClose.panes, 0, "no leftover pane after untiling");
    assert.equal(afterFocusedClose.directStreams, 1, "exactly one stream in the single console — no orphan from the closed tab");
    assert.ok(afterFocusedClose.shownIsA, "the single console shows the SURVIVING tab's own stream, not the closed tab's");
    assert.ok(afterFocusedClose.transcriptHasA, "the surviving tab's content is shown in the single console");
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
