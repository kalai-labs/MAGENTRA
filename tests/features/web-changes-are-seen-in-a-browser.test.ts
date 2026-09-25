/**
 * `web-changes-are-seen-in-a-browser`.
 *
 * Field test 2026-09-23, findings V-01, V-05 and R-4. The agent said
 * "complete, verified" after a bot had driven the game's HTTP API and the page
 * files had answered 200. It never opened the browser client, and the owner
 * found four client defects in minutes. The harness had one sentence that
 * would have sent it there — the runtime-evidence rung's "capture a screenshot
 * of the running app and Read it" (vision was on) — but that rung fires only
 * on a turn that ran NO command, and this one ran 45.
 *
 * `pure` + `fs`, as the record declares. `pure` reads the shipped prompt from
 * the registry, the way `runtime-evidence-floor` does. `fs` runs the real
 * Engine on the scripted provider over a real workspace: `uiFilesAmong` and
 * `looksLikeBrowserRun` are module-private to the finishing rungs, so they are
 * proved through the turns that consult them. Not covered here: a SUCCESSFUL
 * Read of a screenshot counting as evidence — that needs a vision endpoint to
 * describe the image; a Read that fails (vision off) is covered, and must not
 * count.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { promptCatalog } from "@magentra/protocol";
import type { Msg } from "@magentra/providers";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { PureTest } from "../lib/pureTest.ts";
import { startScriptedEngine, type FakeTurn, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "web-changes-are-seen-in-a-browser";

/** Verbatim from the record. */
const INVARIANT =
  "A turn that changed a web page and never looked at it in a browser gets one reminder to drive it the way the user will, or to say it stays unverified; it reminds, never blocks.";

/** The sentence only this rung says. */
const MARKER = "Nothing has been observed in a browser";

/** What the user sees when it fires. */
const NOTE = "↻ the page was never opened in a browser — checking it the way the user will";

/* ---- checklist 2 — the shipped text ---------------------------------- */

class TheShippedText extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "the-shipped-reminder-sends-the-agent-to-a-browser-and-keeps-the-honest-ending";
  readonly whyItExists =
    "the only sentence that pointed at a screenshot lived in a rung the field turn never met, so 'HTTP 200 for the files' was accepted as a verified game";

  override run(t: TestRun): void {
    const rung = promptCatalog().find((p) => p.id === "finishing.browser-evidence");
    t.assert.ok(rung, "the rung is registered, so it can be found and switched off like every other prompt");
    t.assert.equal(rung!.channel, "reminder");
    t.assert.deepEqual([...(rung!.placeholders ?? [])].sort(), ["files", "visionNote"]);
    const text = rung!.defaultText;
    t.assert.match(text, new RegExp(MARKER), "it states the fact that fired it");
    t.assert.match(text, /HTTP 200 and still not work/, "and why the checks it did run do not settle it");
    t.assert.match(text, /each main thing the user asked for with the default settings/, "it asks for the user's own goals, on the settings the user gets");
    t.assert.match(text, /system temp directory, deleted in this same turn/, "the throwaway script stays out of the repository");
    t.assert.match(text, /say plainly that the page itself stays unverified/, "an honest gap is a complete answer");
    t.assert.match(text, /<system-reminder>/);
  }
}

/* ---- checklist 3 and 4 — the live rung --------------------------------- */

abstract class BrowserFloorTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  override readonly timeoutMs: number = 60_000;

  #engine: ScriptedEngine | undefined;
  protected workspace = "";

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  /** One turn that writes `file`, runs `command`, and then tries to end twice. */
  protected async turn(file: string, command: string): Promise<{ notes: readonly string[]; reminders: string[]; calls: number }> {
    this.redirectHome();
    this.workspace = this.tempDir("magentra-browser-");
    const target = join(this.workspace, file);
    const turns: FakeTurn[] = [
      { toolCalls: [{ id: "w1", name: "Write", input: { file_path: target, content: "<h1>game</h1>\n" } }] },
      { toolCalls: [{ id: "b1", name: "Bash", input: { command, description: "check it", run_in_background: false } }] },
      { text: "done", stopReason: "end_turn" },
      { text: "No browser here — the page stays unverified.", stopReason: "end_turn" },
    ];
    this.#engine = await startScriptedEngine({ workspace: this.workspace, turns });
    const outcome = await this.#engine.runTurn("build the game");
    if (outcome.errors.length > 0) throw new Error(outcome.errors.join(" | "));
    const history = (this.#engine.provider.requests.at(-1)?.messages ?? []) as readonly Msg[];
    const reminders = history
      .filter((m) => m.role === "user")
      .flatMap((m) => m.content.map((b) => (b.type === "text" ? b.text : "")))
      .filter((text) => text.includes(MARKER));
    return { notes: outcome.notes, reminders, calls: this.#engine.provider.requests.length };
  }
}

class APageCheckedOnlyFromOutside extends BrowserFloorTest {
  readonly id = "a-page-checked-only-with-commands-gets-one-reminder-and-the-next-end-is-allowed";
  readonly whyItExists =
    "the field turn served the page, got HTTP 200 and declared it verified; the mouse aim, the invisible player and the unshown STAIRS OPEN were all one browser away";

  override async run(t: TestRun): Promise<void> {
    const { notes, reminders, calls } = await this.turn(join("static", "index.html"), "echo served");
    t.assert.equal(calls, 4, "the write, the command, the attempt to end, and the round the reminder bought");
    t.assert.equal(reminders.length, 1, "exactly one browser reminder");
    t.assert.equal(reminders[0]!.includes(join("static", "index.html")), true, "naming the page that changed");
    t.assert.match(reminders[0]!, /Vision is off for this workspace/, "with the vision clause for a workspace that has none");
    t.assert.equal(notes.filter((n) => n === NOTE).length, 1, `the user is told once why the turn went on: ${NOTE}`);
  }
}

class ABrowserRunSettlesIt extends BrowserFloorTest {
  readonly id = "a-browser-run-settles-it-and-a-server-only-change-never-asks";
  readonly whyItExists =
    "a reminder that fired on a turn which HAD driven the page, or on a Python server edit, would teach the model to skim past the one that matters";

  override async run(t: TestRun): Promise<void> {
    const driven = await this.turn(join("src", "Game.tsx"), 'node -e "process.exit(0)" -- --headless --screenshot=shot.png');
    t.assert.equal(driven.reminders.length, 0, "a command that drives a headless browser is the evidence the rung asks for");
    t.assert.equal(driven.calls, 3, "so the turn ends where the model ended it");

    await this.tearDown();
    const server = await this.turn("server.py", "echo ran");
    t.assert.equal(server.reminders.length, 0, "a server file is proven by running it, which the turn did");
    t.assert.equal(server.calls, 3);
  }
}

class AFailedScreenshotReadIsNotEvidence extends BrowserFloorTest {
  readonly id = "a-screenshot-read-that-failed-is-not-evidence";
  readonly whyItExists =
    "with vision off, Read refuses an image — counting that attempt as 'looked at the page' would let a turn that saw nothing skip the reminder";

  override async run(t: TestRun): Promise<void> {
    this.redirectHome();
    this.workspace = this.tempDir("magentra-browser-img-");
    const page = join(this.workspace, "index.html");
    const shot = join(this.workspace, "shot.png");
    writeFileSync(shot, "a screenshot the turn took");
    const engine = await startScriptedEngine({
      workspace: this.workspace,
      turns: [
        { toolCalls: [{ id: "w1", name: "Write", input: { file_path: page, content: "<h1>game</h1>\n" } }] },
        { toolCalls: [{ id: "b1", name: "Bash", input: { command: "echo served", description: "serve it", run_in_background: false } }] },
        { toolCalls: [{ id: "r1", name: "Read", input: { file_path: shot } }] },
        // The refused Read made the last batch an error: the recovery rung takes this round.
        { text: "done", stopReason: "end_turn" },
        { text: "done", stopReason: "end_turn" },
        { text: "The page stays unverified.", stopReason: "end_turn" },
      ],
    });
    try {
      const outcome = await engine.runTurn("build the game");
      t.assert.deepEqual([...outcome.errors], []);
      t.assert.equal(outcome.toolResults.find((r) => r.id === "r1")?.isError, true, "Read refused the image: vision is off here");
      t.assert.equal(outcome.notes.includes(NOTE), true, "so the page was never seen, and the rung still fires");
    } finally {
      await engine.close();
    }
  }
}

/* ---- a mention, an install or a failed run is not a browser run -------- */

class OnlyARealRunCounts extends BrowserFloorTest {
  readonly id = "a-mention-an-install-a-version-check-or-a-failed-browser-run-is-not-evidence";
  readonly whyItExists =
    "the browser check matched the words anywhere in a command, so `npx playwright install`, `cat playwright.config.ts` or a playwright run that crashed each counted as having looked at the page";

  override async run(t: TestRun): Promise<void> {
    // Each command names a browser tool and drives none (the `||` branch never
    // runs, so nothing is installed); curl is the field turn's own check.
    for (const command of [
      "cat playwright.config.ts 2>/dev/null; true",
      "true || npx playwright install chromium",
      "true || npm i -D puppeteer",
      "true || npx playwright --version",
      "curl -s http://127.0.0.1:9/ || true",
    ]) {
      const { reminders, calls } = await this.turn("index.html", command);
      t.assert.equal(reminders.length, 1, `"${command}" is not a browser run, so the page still gets its reminder`);
      t.assert.equal(calls, 4);
      await this.tearDown();
    }

    // A browser run that FAILED saw no page either.
    this.redirectHome();
    this.workspace = this.tempDir("magentra-browser-fail-");
    const engine = await startScriptedEngine({
      workspace: this.workspace,
      turns: [
        { toolCalls: [{ id: "w1", name: "Write", input: { file_path: join(this.workspace, "index.html"), content: "<h1>game</h1>\n" } }] },
        { toolCalls: [{ id: "b1", name: "Bash", input: { command: 'node -e "process.exit(3)" -- --headless --screenshot=shot.png', description: "screenshot it", run_in_background: false } }] },
        // The failed command made the last batch an error: the recovery rung takes this round.
        { text: "done", stopReason: "end_turn" },
        { text: "done", stopReason: "end_turn" },
        { text: "The page stays unverified.", stopReason: "end_turn" },
      ],
    });
    try {
      const outcome = await engine.runTurn("build the game");
      t.assert.deepEqual([...outcome.errors], []);
      t.assert.equal(outcome.toolResults.find((r) => r.id === "b1")?.isError, true, "the headless run failed");
      t.assert.equal(outcome.notes.includes(NOTE), true, "so the page was never seen, and the rung still fires");
    } finally {
      await engine.close();
    }
  }
}

/* ---- the browser shape keeps its own fuse ------------------------------ */

class ItsOwnFuse extends BrowserFloorTest {
  readonly id = "a-ui-turn-reminded-to-run-something-is-still-sent-to-a-browser-when-it-then-checks-with-curl";
  readonly whyItExists =
    "the browser reminder shared the runtime-evidence fuse, so a page turn that first ran nothing got the run-something reminder, answered it with one curl, and ended with the page never opened";

  override async run(t: TestRun): Promise<void> {
    this.redirectHome();
    this.workspace = this.tempDir("magentra-browser-fuse-");
    const engine = await startScriptedEngine({
      workspace: this.workspace,
      turns: [
        { toolCalls: [{ id: "w1", name: "Write", input: { file_path: join(this.workspace, "index.html"), content: "<h1>game</h1>\n" } }] },
        { text: "done", stopReason: "end_turn" },
        { toolCalls: [{ id: "b1", name: "Bash", input: { command: "curl -s http://127.0.0.1:9/ || true", description: "check it", run_in_background: false } }] },
        { text: "done", stopReason: "end_turn" },
        { text: "No browser here — the page stays unverified.", stopReason: "end_turn" },
      ],
    });
    try {
      const outcome = await engine.runTurn("build the game");
      t.assert.deepEqual([...outcome.errors], []);
      t.assert.equal(outcome.notes.includes("↻ nothing was run — verifying the change for real"), true, "first the page turn is told to run something");
      t.assert.equal(outcome.notes.filter((n) => n === NOTE).length, 1, "and after a curl-only check it is still sent to a browser, once");
      t.assert.equal(engine.provider.requests.length, 5, "each reminder buys one round; the last end is allowed");
    } finally {
      await engine.close();
    }
  }
}

/* ---- which files are the page ------------------------------------------- */

class WhichFilesArePages extends BrowserFloorTest {
  readonly id = "htm-sass-and-less-are-pages-and-code-and-a-test-spec-or-story-file-is-not-the-page";
  readonly whyItExists =
    "`.htm`, `.sass` and `.less` pages were missing from both the code set and the page set, and a changed `App.test.tsx` asked for a browser as if it were the page";

  override async run(t: TestRun): Promise<void> {
    for (const file of ["page.htm", join("styles", "main.sass"), join("styles", "theme.less")]) {
      this.redirectHome();
      this.workspace = this.tempDir("magentra-browser-ext-");
      const engine = await startScriptedEngine({
        workspace: this.workspace,
        turns: [
          { toolCalls: [{ id: "w1", name: "Write", input: { file_path: join(this.workspace, file), content: "x\n" } }] },
          { text: "done", stopReason: "end_turn" },
          { text: "done", stopReason: "end_turn" },
          { text: "It stays unverified.", stopReason: "end_turn" },
        ],
      });
      try {
        const outcome = await engine.runTurn("style the page");
        t.assert.deepEqual([...outcome.errors], []);
        t.assert.equal(outcome.notes.includes("↻ nothing was run — verifying the change for real"), true, `${file} is code: an unrun change to it is reminded`);
        t.assert.equal(outcome.notes.includes(NOTE), true, `${file} is part of the page: it is sent to a browser too`);
      } finally {
        await engine.close();
      }
    }

    for (const file of [join("src", "App.test.tsx"), join("src", "Button.spec.jsx"), join("src", "Card.stories.tsx")]) {
      const { reminders, calls } = await this.turn(file, "echo ran");
      t.assert.equal(reminders.length, 0, `${file} is a test of the page, not the page`);
      t.assert.equal(calls, 3);
      await this.tearDown();
    }
  }
}

registerFeatureTests(
  new TheShippedText(),
  new APageCheckedOnlyFromOutside(),
  new ABrowserRunSettlesIt(),
  new AFailedScreenshotReadIsNotEvidence(),
  new OnlyARealRunCounts(),
  new ItsOwnFuse(),
  new WhichFilesArePages(),
);
