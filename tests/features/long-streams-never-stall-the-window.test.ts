/**
 * `long-streams-never-stall-the-window`.
 *
 * In the 2026-09-23 field test the window said "reasoning" for 25 minutes
 * while the engine was already writing files, and then every step seemed to
 * finish in 0 s. The renderer appended one text node per reasoning token
 * (127,802 in that run) and read `scrollHeight` around each one. With the
 * reasoning block open — the owner had opened it — every token re-laid out the
 * whole block, so the cost of a delta grew with everything before it. Every
 * later frame waits behind that backlog: task updates, tool rows, the turn end.
 * The now-line meanwhile read "thinking · Enemy · 0s", because each token
 * replaced its detail and restarted its timer.
 *
 * `ui`, and every frame here goes through `win.webContents.send("engine:event",
 * …)` in the main process — the call `app/main.js` makes for each line of
 * engine stdout — so the renderer receives them exactly as it receives an
 * engine's: one IPC message per frame, handled in order, sharing one thread
 * with layout and paint. Calling `handleEngineEvent` directly would skip the
 * queue the field run was stuck in.
 *
 * WHERE THE TIMES COME FROM. The page's bridge lets a second listener join the
 * same channel (`window.magentra.onEvent` wraps `ipcRenderer.on`), and
 * listeners run in the order they were added, so a probe added after the
 * product's own runs right after the product has finished with that frame. Its
 * `performance.now()` marks when the renderer was done with it, including any
 * frame it drew in between. The probe observes; it changes nothing the product
 * does. Timings are compared as RATIOS of one run against itself, never
 * against a number of milliseconds, so a slow machine and a fast one agree.
 */

import { join } from "node:path";

import { openWorkspace, waitForSpawn } from "../lib/appDriver.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { UiTest, type AppHandle } from "../lib/uiTest.ts";

const FEATURE = "long-streams-never-stall-the-window";

/** Verbatim from the record. */
const INVARIANT =
  "A streamed delta costs the renderer the same however long the stream has run, so the frames after a long reasoning stream show at once, in order and in their own tab, and the now-line never shows a raw token.";

const LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1";

/**
 * The vocabulary of every generated stream: words none of the app's own chrome
 * ever says, so finding one on the now-line can only mean a streamed token
 * leaked onto it.
 */
const WORDS = [" quokka", " zephyr", " marmot", " vellum", " axolotl", " quince", " fjord", " gnomon", " tamarin", ",", "."];

/**
 * A seeded stream, identical on every run: about four characters per delta and
 * a newline now and then — the shape of the field log (127,802 reasoning
 * deltas, 4.2 characters each on average).
 */
function deltas(count: number, seed: number, blankLineEvery = 0): string[] {
  let s = seed;
  const rnd = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let text = WORDS[Math.floor(rnd() * WORDS.length)]!;
    if (rnd() < 0.03) text += "\n";
    if (blankLineEvery > 0 && i % blankLineEvery === blankLineEvery - 1) text += "\n\n";
    out.push(text);
  }
  return out;
}

/** The delta count between two probe marks. */
const SLICE = 500;

/** How much a slice late in the stream may cost against one early in it. */
const MAX_SLICE_RATIO = 2;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** What the renderer-side probe recorded. */
interface Probe {
  readonly counted: number;
  readonly marks: readonly [number, number][];
  readonly samples: readonly string[];
  readonly taskAt: number | null;
  readonly rail: { progress: string; list: string } | null;
}

abstract class StreamTest extends UiTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** A workspace directory with a connection the engine can boot on. Nothing is ever asked of the endpoint. */
  protected workspace(tag: string): string {
    const dir = this.makeTempDir(`magentra-stream-${tag}-`);
    this.writeJsonFile(join(dir, ".magentra", "settings.json"), {
      provider: "openai-compatible",
      baseUrl: LOCAL_ENDPOINT,
      model: `model-${tag}`,
    });
    return dir;
  }

  /** The app with one console open, and the tab id main stamps on that console's frames. */
  protected async console(): Promise<{ app: AppHandle; tabId: string }> {
    const home = this.makeTempDir("magentra-stream-home-");
    const workspace = this.workspace("one");
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await openWorkspace(app, workspace);
    await waitForSpawn(workspace);
    const tabId = await this.waitFor(app, `typeof focusedTabId === "string" && focusedTabId ? focusedTabId : null`, "the console's tab id");
    return { app, tabId: tabId as string };
  }

  /** Send frames from the main process, in order, exactly as `sendToRenderer` does. */
  protected async sendFrames(app: AppHandle, frames: readonly Record<string, unknown>[]): Promise<void> {
    await app.evaluateInMain(`
      for (const frame of ${JSON.stringify(frames)}) win.webContents.send("engine:event", frame);
      return true;
    `);
  }

  /** One burst of deltas of one frame type, all queued at once, for one tab. */
  protected async burst(app: AppHandle, type: string, texts: readonly string[], tabId: string): Promise<void> {
    await app.evaluateInMain(`
      const tabId = ${JSON.stringify(tabId)};
      for (const text of ${JSON.stringify(texts)}) win.webContents.send("engine:event", { type: ${JSON.stringify(type)}, text, tabId });
      return true;
    `);
  }

  /**
   * Count every `type` frame the renderer handles from now on, marking the
   * time at the first and at every {@link SLICE}th, sampling the now-line at
   * every `sampleEvery`th, and noting when a task list naming `taskSubject`
   * arrives (and what the rail showed at that moment).
   */
  protected async installProbe(app: AppHandle, type: string, sampleEvery = 0, taskSubject = ""): Promise<void> {
    await app.evaluate(`
      (() => {
        const probe = { counted: 0, marks: [], samples: [], taskAt: null, rail: null };
        window.__streamProbe = probe;
        window.magentra.onEvent((e) => {
          if (e.type === ${JSON.stringify(type)}) {
            probe.counted++;
            if (probe.counted === 1 || probe.counted % ${SLICE} === 0) probe.marks.push([probe.counted, performance.now()]);
            if (${sampleEvery} > 0 && probe.counted % ${sampleEvery} === 0) probe.samples.push(nowTextEl.textContent || "");
          }
          if (e.type === "task_list_updated" && (e.tasks || []).some((t) => t.subject === ${JSON.stringify(taskSubject)})) {
            probe.taskAt = Date.now();
            probe.rail = { progress: taskProgressEl.textContent || "", list: taskListEl.textContent || "" };
          }
        });
        return true;
      })()
    `);
  }

  /** The probe, once it has counted `count` frames. */
  protected async probeAfter(app: AppHandle, count: number): Promise<Probe> {
    return this.waitFor<Probe>(app, `window.__streamProbe && window.__streamProbe.counted >= ${count} ? window.__streamProbe : null`, `the renderer to handle ${count} deltas`);
  }

  /** Median slice cost among the first `n` deltas and among the last `n`, from the probe's marks. */
  protected sliceCosts(probe: Probe, total: number, n: number): { early: number; late: number; ratio: number; slices: number[] } {
    const slices: { end: number; ms: number }[] = [];
    for (let i = 1; i < probe.marks.length; i++) {
      slices.push({ end: probe.marks[i]![0], ms: probe.marks[i]![1] - probe.marks[i - 1]![1] });
    }
    const early = median(slices.filter((s) => s.end <= n).map((s) => s.ms));
    const late = median(slices.filter((s) => s.end > total - n).map((s) => s.ms));
    return { early, late, ratio: late / early, slices: slices.map((s) => Math.round(s.ms)) };
  }

  /** Start a reasoning block with one delta and open it, as the owner did in the field run. */
  protected async openReasoningBlock(app: AppHandle, tabId: string): Promise<void> {
    await this.sendFrames(app, [
      { type: "turn_started", tabId },
      { type: "thinking_delta", text: "Planning", tabId },
    ]);
    await this.waitFor(app, `currentThinkingEl ? true : null`, "the reasoning block to exist");
    await app.evaluate(`currentThinkingEl.querySelector("summary").click(); currentThinkingEl.open`);
  }
}

/* ---- checklist 1 ------------------------------------------------------- */

class ReasoningCostsTheSameAtTheEnd extends StreamTest {
  readonly id = "a-long-reasoning-stream-costs-the-same-per-delta-at-the-end-as-at-the-start";
  readonly whyItExists =
    "with the reasoning block open, each token re-laid out everything before it: 2,000 deltas took 6.7 s at the start of a stream and 109.9 s after 10,000, so the window fell 25 minutes behind an engine that was already writing files";

  override async run(t: TestRun): Promise<void> {
    const { app, tabId } = await this.console();
    await this.openReasoningBlock(app, tabId);

    const TOTAL = 6_000;
    const stream = deltas(TOTAL, 7);
    await this.installProbe(app, "thinking_delta");
    await this.burst(app, "thinking_delta", stream, tabId);
    const probe = await this.probeAfter(app, TOTAL);

    const cost = this.sliceCosts(probe, TOTAL, 2_000);
    t.diagnostic(`median ms per ${SLICE} deltas: first 2,000 ${cost.early.toFixed(1)}, last 2,000 ${cost.late.toFixed(1)}; slices ${cost.slices.join(" ")}`);
    t.assert.ok(
      cost.ratio <= MAX_SLICE_RATIO,
      `a delta late in the stream must cost what one early in it did — the last 2,000 cost ${cost.ratio.toFixed(1)}x the first 2,000 per ${SLICE}-delta slice (at most ${MAX_SLICE_RATIO}x)`,
    );

    // The live block is bounded while it streams — once whatever was buffered is drawn.
    const full = `Planning${stream.join("")}`;
    const tail = full.slice(-40);
    const live = await this.waitFor<{ nodes: number; chars: number }>(
      app,
      `(() => {
        const body = currentThinkingEl && currentThinkingEl.querySelector(".thinking-body");
        if (!body || !(body.textContent || "").endsWith(${JSON.stringify(tail)})) return null;
        return { nodes: body.childNodes.length, chars: (body.textContent || "").length };
      })()`,
      "the live reasoning block to show the end of the stream",
    );
    t.assert.ok(live.nodes <= 3, `the live reasoning block must stay a few DOM nodes however long it runs; it holds ${live.nodes}`);
    t.assert.ok(live.chars <= 12_000, `and only the recent part of the text while it streams; it shows ${live.chars} characters`);

    // A tool call ends the block: all of it is there, and the row comes after it.
    await this.sendFrames(app, [{ type: "tool_call_started", id: "call-1", tool: "Read", input: { file_path: "a.ts" }, tabId }]);
    const ended = await this.waitFor<{ text: string; done: boolean; rowAfter: boolean; blocks: number }>(
      app,
      `(() => {
        const blocks = [...streamEl.querySelectorAll(".msg-thinking")];
        const block = blocks[blocks.length - 1];
        const row = streamEl.querySelector(".tool-row");
        if (!block || !row) return null;
        return {
          text: block.querySelector(".thinking-body").textContent || "",
          done: block.classList.contains("done"),
          rowAfter: Boolean(block.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING),
          blocks: blocks.length,
        };
      })()`,
      "the tool row",
    );
    t.assert.equal(ended.blocks, 1, "one reasoning stretch is one block");
    t.assert.equal(ended.done, true, "the tool call ends the reasoning block");
    t.assert.equal(ended.text.length, full.length, "the ended block holds the whole reasoning, not only the tail it showed while live");
    t.assert.equal(ended.text, full, "every delta, in the order it was sent");
    t.assert.equal(ended.rowAfter, true, "the tool row that followed the reasoning comes after it in the transcript");
  }
}

/* ---- checklist 2 ------------------------------------------------------- */

class TheRailKeepsUpWithReasoning extends StreamTest {
  readonly id = "the-task-rail-keeps-up-with-reasoning-at-the-field-runs-peak-rate";
  readonly whyItExists =
    "the Tasks panel sat at 0/7 while the engine was on task 5, because the task update waited in the renderer's queue behind minutes of reasoning deltas; a task update sent after 12,000 of them reached the rail 301 s late";

  /** The paced stream runs 20 s, and the code this was written against then needed minutes more. */
  override readonly timeoutMs: number = 240_000;

  override async run(t: TestRun): Promise<void> {
    const { app, tabId } = await this.console();
    await this.openReasoningBlock(app, tabId);

    const RATE = 250; // deltas per second: the field log's busiest second held 249
    const SECONDS = 20;
    const TOTAL = RATE * SECONDS;
    const SUBJECT = "Build the quokka enemy";
    await this.installProbe(app, "thinking_delta", 0, SUBJECT);

    // Paced by the clock rather than by timer ticks, which Windows rounds to
    // 15.6 ms: each tick sends whatever the rate says is due by now.
    await app.evaluateInMain(`
      const tabId = ${JSON.stringify(tabId)};
      const texts = ${JSON.stringify(deltas(TOTAL, 11))};
      const run = { done: false, first: Date.now(), last: 0, taskSentAt: 0 };
      globalThis.__paced = run;
      let sent = 0;
      const tick = setInterval(() => {
        const due = Math.min(texts.length, Math.floor(((Date.now() - run.first) * ${RATE}) / 1000));
        while (sent < due) win.webContents.send("engine:event", { type: "thinking_delta", text: texts[sent++], tabId });
        if (sent < texts.length) return;
        clearInterval(tick);
        run.last = Date.now();
        win.webContents.send("engine:event", {
          type: "task_list_updated",
          tasks: [{ id: "1", subject: ${JSON.stringify(SUBJECT)}, status: "in_progress" }],
          tabId,
        });
        run.taskSentAt = Date.now();
        run.done = true;
      }, 10);
      return true;
    `);

    const deadline = Date.now() + 60_000;
    let run = { done: false, first: 0, last: 0, taskSentAt: 0 };
    while (!run.done) {
      if (Date.now() > deadline) throw new Error("the main process did not finish sending the paced stream");
      await new Promise((resolve) => setTimeout(resolve, 500));
      run = await app.evaluateInMain<typeof run>("return globalThis.__paced;");
    }

    const probe = await this.waitFor<Probe>(app, `window.__streamProbe && window.__streamProbe.taskAt !== null ? window.__streamProbe : null`, "the task update to reach the renderer", 200_000);
    const streamMs = run.last - run.first;
    const lagMs = (probe.taskAt ?? 0) - run.taskSentAt;
    t.diagnostic(`stream ${streamMs} ms for ${TOTAL} deltas; the task update was handled ${lagMs} ms after it was sent`);
    t.assert.equal(probe.counted, TOTAL, "every reasoning delta was handled, and before the task update that followed them");
    t.assert.ok(
      lagMs <= streamMs / 4,
      `a task update sent after ${SECONDS} s of reasoning must show while it is still news — it was handled ${(lagMs / 1000).toFixed(1)} s after it was sent, against a ${(streamMs / 1000).toFixed(1)} s stream (at most a quarter of it)`,
    );
    t.assert.equal(probe.rail?.progress, "0/1", "and the rail shows the new task list the moment it is handled");
    t.assert.match(probe.rail?.list ?? "", /Build the quokka enemy/, "naming the task that started");
  }
}

/* ---- checklist 3 ------------------------------------------------------- */

class TheNowLineNamesTheActivity extends StreamTest {
  readonly id = "the-now-line-names-the-activity-and-never-a-streamed-token";
  readonly whyItExists =
    "the status line read 'thinking · Enemy · 0s' for the whole run: every token replaced its detail and restarted its timer, so it showed noise and claimed nothing had been going on for longer than a moment";

  override async run(t: TestRun): Promise<void> {
    const { app, tabId } = await this.console();
    await this.sendFrames(app, [{ type: "turn_started", tabId }]);

    const RATE = 100;
    const SECONDS = 6;
    const TOTAL = RATE * SECONDS;
    await this.installProbe(app, "thinking_delta", 50);
    await app.evaluateInMain(`
      const tabId = ${JSON.stringify(tabId)};
      const texts = ${JSON.stringify(deltas(TOTAL, 13))};
      const first = Date.now();
      let sent = 0;
      const tick = setInterval(() => {
        const due = Math.min(texts.length, Math.floor(((Date.now() - first) * ${RATE}) / 1000));
        while (sent < due) win.webContents.send("engine:event", { type: "thinking_delta", text: texts[sent++], tabId });
        if (sent >= texts.length) clearInterval(tick);
      }, 10);
      return true;
    `);

    const probe = await this.probeAfter(app, TOTAL);
    t.diagnostic(`now-line samples: ${probe.samples.join(" | ")}`);
    t.assert.equal(probe.samples.length, TOTAL / 50, "the now-line was read after every 50th delta");

    const leaked = probe.samples.filter((line) => WORDS.some((w) => /\w/.test(w) && line.includes(w.trim())));
    t.assert.deepEqual(leaked, [], "the now-line names what the agent is doing; a streamed token on it is noise");

    const seconds = probe.samples.map((line) => {
      const m = /^thinking · (\d+)s$/.exec(line);
      return m ? Number(m[1]) : NaN;
    });
    t.assert.ok(seconds.every((n) => Number.isInteger(n)), `each reading is "thinking · <n>s"; got ${JSON.stringify(probe.samples.slice(0, 3))}`);
    t.assert.ok(
      seconds.every((n, i) => i === 0 || n >= seconds[i - 1]!),
      `the timer counts the reasoning stretch — a delta must never restart it; read ${seconds.join(", ")}`,
    );
    t.assert.ok(seconds[seconds.length - 1]! > 0, `after ${SECONDS} s of reasoning the timer has moved; it read ${seconds[seconds.length - 1]}`);
  }
}

/* ---- checklist 4 ------------------------------------------------------- */

class ALongCodeAnswerCostsTheSame extends StreamTest {
  readonly id = "a-long-code-answer-costs-the-same-per-delta-at-the-end-as-at-the-start";
  readonly whyItExists =
    "an answer that is one long code block has no safe cut until its fence closes, so the whole block stayed in the live tail and every delta re-laid it out: 2,000 deltas took 3.2 s at the start and 28.7 s after 10,000";

  override async run(t: TestRun): Promise<void> {
    const { app, tabId } = await this.console();
    await this.sendFrames(app, [
      { type: "turn_started", tabId },
      { type: "text_delta", text: "```js\n", tabId },
    ]);
    await this.waitFor(app, `currentAssistantEl ? true : null`, "the answer to start");

    const TOTAL = 6_000;
    // Blank lines inside the fence: each one is a cut point that must be refused.
    const code = deltas(TOTAL, 17, 40);
    await this.installProbe(app, "text_delta");
    await this.burst(app, "text_delta", code, tabId);
    const probe = await this.probeAfter(app, TOTAL);

    const cost = this.sliceCosts(probe, TOTAL, 2_000);
    t.diagnostic(`median ms per ${SLICE} deltas: first 2,000 ${cost.early.toFixed(1)}, last 2,000 ${cost.late.toFixed(1)}; slices ${cost.slices.join(" ")}`);
    t.assert.ok(
      cost.ratio <= MAX_SLICE_RATIO,
      `a delta late in a long code block must cost what one early in it did — the last 2,000 cost ${cost.ratio.toFixed(1)}x the first 2,000 per ${SLICE}-delta slice (at most ${MAX_SLICE_RATIO}x)`,
    );

    await this.sendFrames(app, [
      { type: "text_delta", text: "\n```\n\nDone.", tabId },
      { type: "turn_finished", stopReason: "end_turn", tabId },
    ]);
    const body = code.join("");
    const final = await this.waitFor<{ blocks: number; code: string; text: string }>(
      app,
      `(() => {
        if (busy) return null;
        const messages = [...streamEl.querySelectorAll(".msg-assistant")];
        const last = messages[messages.length - 1];
        if (!last) return null;
        const blocks = last.querySelectorAll("pre.md-code");
        return { blocks: blocks.length, code: blocks.length ? blocks[0].textContent || "" : "", text: last.querySelector(".msg-body").textContent || "" };
      })()`,
      "the answer to finish",
    );
    t.assert.equal(final.blocks, 1, "the finished answer is one code block — no blank line inside the fence split it");
    t.assert.equal(final.code.length, body.length, "holding the whole of the code");
    t.assert.equal(final.code, body, "exactly as it was sent");
    t.assert.match(final.text, /Done\.$/, "followed by the text after the fence");
  }
}

/* ---- checklist 5 ------------------------------------------------------- */

class ABackgroundTabsReasoningStaysInItsPane extends StreamTest {
  readonly id = "a-background-tabs-reasoning-stays-in-its-own-pane-across-a-focus-change";
  readonly whyItExists =
    "each tab swaps its console into the shared globals only while its own frame is handled; reasoning held for a later frame and then written into whatever console is live would put one workspace's thoughts in another's transcript, or drop them at a focus change";

  override async run(t: TestRun): Promise<void> {
    const home = this.makeTempDir("magentra-stream-home-");
    const first = this.workspace("a");
    const second = this.workspace("b");
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await app.evaluateInMain(`
      globalThis.__tabs = [];
      const realSend = win.webContents.send.bind(win.webContents);
      win.webContents.send = (channel, payload, ...rest) => {
        if (channel === "tab:opened") globalThis.__tabs.push(payload);
        return realSend(channel, payload, ...rest);
      };
      return true;
    `);
    await openWorkspace(app, first);
    await waitForSpawn(first);
    await openWorkspace(app, second);
    await waitForSpawn(second);
    const opened = await app.evaluateInMain<{ tabId: string; workspace: string }[]>("return globalThis.__tabs;");
    const firstTab = opened.find((tab) => tab.workspace === first)?.tabId ?? "";
    const secondTab = opened.find((tab) => tab.workspace === second)?.tabId ?? "";
    if (!firstTab || !secondTab) throw new Error(`both workspaces must have tabs; saw ${JSON.stringify(opened)}`);
    await this.waitFor(app, `document.body.classList.contains("tiled") && focusedTabId === ${JSON.stringify(secondTab)} ? true : null`, "two tiled consoles, the second focused");

    const pane = (tab: string): string => `document.querySelector('.console-pane[data-tab="${tab}"] .stream')`;
    const reasoningIn = (tab: string): string => `(() => {
      const s = ${pane(tab)};
      return s ? [...s.querySelectorAll(".msg-thinking .thinking-body")].map((b) => b.textContent || "") : null;
    })()`;

    const before = deltas(1_500, 19);
    const after = deltas(1_500, 23);
    await this.installProbe(app, "thinking_delta");
    await this.sendFrames(app, [{ type: "turn_started", tabId: firstTab }]);
    await this.burst(app, "thinking_delta", before, firstTab);

    // While it is in the background, its reasoning shows in its OWN pane — held
    // text that only reached the page once its tab was focused would leave a
    // tiled pane frozen for as long as the user looked at another one.
    const end = before.join("").slice(-40);
    await this.waitFor(
      app,
      `(() => { const r = ${reasoningIn(firstTab)}; return r && r.length === 1 && r[0].endsWith(${JSON.stringify(end)}) ? true : null; })()`,
      "the background tab's reasoning to show in its own pane",
      20_000,
    );
    t.assert.deepEqual(await app.evaluate<string[] | null>(reasoningIn(secondTab)), [], "while the focused console gained no reasoning");

    // Moved while the first tab's deltas are still arriving, through the real
    // preload call a click on its pane makes.
    await app.evaluate(`window.magentra.focusTab(${JSON.stringify(firstTab)}); true`);
    await this.burst(app, "thinking_delta", after, firstTab);
    await this.probeAfter(app, before.length + after.length);

    const unfocusedNow = await app.evaluate<string[] | null>(reasoningIn(secondTab));
    t.assert.deepEqual(unfocusedNow, [], "the other workspace's console still gained no reasoning");

    await this.sendFrames(app, [{ type: "tool_call_started", id: "call-a", tool: "Read", input: { file_path: "a.ts" }, tabId: firstTab }]);
    const whole = before.join("") + after.join("");
    const owned = await this.waitFor<string[]>(
      app,
      `(() => {
        const s = ${pane(firstTab)};
        const ended = s ? s.querySelectorAll(".msg-thinking.done").length : 0;
        return ended > 0 ? ${reasoningIn(firstTab)} : null;
      })()`,
      "the first tab's reasoning block to end",
    );
    t.assert.equal(owned.length, 1, "the first tab holds its one reasoning block");
    t.assert.equal(owned[0], whole, "every delta sent to it, in order, across the focus change");
    t.assert.deepEqual(await app.evaluate<string[] | null>(reasoningIn(secondTab)), [], "and the other console still has none");
    t.assert.equal(await app.evaluate<string>(`focusedTabId`), firstTab, "the focus change did happen");
  }
}

/* ---- checklist 6 ------------------------------------------------------- */

class ARestoredSessionShowsTheWholeReasoning extends StreamTest {
  readonly id = "a-restored-session-still-shows-the-whole-reasoning";
  readonly whyItExists =
    "bounding the live reasoning block must not reach replay: a resumed conversation is where someone goes back to read why the agent did what it did, and a block cut to its tail there would be lost reasoning";

  override async run(t: TestRun): Promise<void> {
    const { app, tabId } = await this.console();
    const reasoning = deltas(60_000, 29).join("").slice(0, 200_000).padEnd(200_000, ".");
    await this.sendFrames(app, [
      {
        type: "session_restored",
        messages: [
          { role: "user", text: "build the game" },
          { role: "assistant", thinking: reasoning, text: "Done.", toolCalls: [] },
        ],
        tabId,
      },
    ]);
    const shown = await this.waitFor<string>(
      app,
      `(() => { const b = streamEl.querySelector(".msg-thinking .thinking-body"); return b ? b.textContent || "" : null; })()`,
      "the restored reasoning block",
    );
    t.assert.equal(shown.length, 200_000, "all 200,000 characters of the restored reasoning are in its block");
    t.assert.equal(shown, reasoning, "exactly as the transcript holds them");
  }
}

registerFeatureTests(
  new ReasoningCostsTheSameAtTheEnd(),
  new TheRailKeepsUpWithReasoning(),
  new TheNowLineNamesTheActivity(),
  new ALongCodeAnswerCostsTheSame(),
  new ABackgroundTabsReasoningStaysInItsPane(),
  new ARestoredSessionShowsTheWholeReasoning(),
);
