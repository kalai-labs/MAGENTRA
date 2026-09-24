/**
 * `guard-status-lines-tell-the-truth`.
 *
 * Field test 2026-09-23, finding S-02. At start the engine said "deletion
 * guard on — destructive calls always ask"; the agent then ran `rm -f` twice
 * with no prompt (`source: mode`). OVERDRIVE turns the deletion guard off by
 * design — `deletion-guard` proves it — so the line was the defect, not the
 * guard. The desktop said the same false thing twice more: the glossary
 * ("always ask first — even in OVERDRIVE") and the footer ("autonomous ·
 * deletions always ask"); outside OVERDRIVE the footer said "asks before
 * commands", although commands have not asked since the stance default became
 * allow.
 *
 * `proc` + `ui`. The record first said `fs` for the engine half, but checklist
 * item 1 compares each line with what a REAL deletion then does in the same
 * engine, and a real deletion is the Bash tool spawning a real shell — the
 * `proc` kind, as the live half of `deletion-guard` already is. Re-declared
 * where the test sits, as `tests/README.md` asks ("kinds are a claim").
 *
 * The lines are not matched word for word. Each is held against the behaviour
 * of its own stance: where a deletion asks, the line says it asks; where it
 * runs unasked, the line says so or names OVERDRIVE as the reason — and no
 * line ever says "always ask".
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CoreEvent } from "@magentra/protocol";

import { openWorkspace, waitForSpawn } from "../lib/appDriver.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { ProcTest } from "../lib/procTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";
import { UiTest } from "../lib/uiTest.ts";

const FEATURE = "guard-status-lines-tell-the-truth";

/** Verbatim from the record. */
const INVARIANT =
  "Every line that tells the user what the deletion guard and OVERDRIVE do says what the permission engine really does in that stance.";

/* ---- checklist 1 ----------------------------------------------------- */

class TheEngineLinesMatchTheGuard extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "the-guard-status-line-agrees-with-what-a-real-deletion-does-in-each-stance";
  readonly whyItExists =
    "the engine announced 'destructive calls always ask' and then, in OVERDRIVE, ran `rm -f` twice with no prompt — the user trusted a promise the permission engine never made";

  #engines: ScriptedEngine[] = [];
  #dirs: string[] = [];
  #savedEnv = new Map<string, string | undefined>();

  /** `loadSettings` merges `~/.magentra/settings.json` over the workspace's, so HOME is redirected. */
  override setUp(): void {
    const home = this.#makeDir("magentra-status-home-");
    for (const name of ["HOME", "USERPROFILE"] as const) {
      this.#savedEnv.set(name, process.env[name]);
      process.env[name] = home;
    }
  }

  #makeDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    this.#dirs.push(dir);
    return dir;
  }

  /** Engines close before their directories go: a live shell holds its cwd on Windows. */
  override async tearDown(): Promise<void> {
    try {
      for (const engine of this.#engines) await engine.close();
      this.#engines = [];
    } finally {
      for (const [name, value] of this.#savedEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      this.#savedEnv.clear();
      for (const dir of this.#dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
    }
  }

  /** The status line the engine prints for this stance, and whether a real `rm` then asked. */
  async #stance(guard: boolean, overdrive: boolean): Promise<{ line: string; asked: boolean; deleted: boolean }> {
    const workspace = this.#makeDir("magentra-status-ws-");
    const doomed = join(workspace, "doomed.txt");
    writeFileSync(doomed, "scratch\n", "utf8");
    const engine = await startScriptedEngine({
      workspace,
      settings: { permissions: { allow: ["Bash"], deny: [], allowExact: [] } },
      // A prompt is answered no, so "deleted" can only mean "nothing asked".
      permissions: "deny",
      turns: [
        { toolCalls: [{ name: "Bash", input: { command: "rm -f doomed.txt", description: "Tidy up", run_in_background: false } }] },
        { text: "handled" },
        { text: "nothing further" },
        { text: "nothing further" },
        { text: "nothing further" },
      ],
    });
    this.#engines.push(engine);
    // The desktop's order on a link: the guard first, then the stance.
    engine.send({ type: "set_deletion_guard", enabled: guard });
    const status = await engine.waitFor(
      (e): e is Extract<CoreEvent, { type: "command_output" }> => e.type === "command_output" && e.text.startsWith("deletion guard"),
    );
    if (overdrive) {
      engine.send({ type: "set_overdrive", enabled: true });
      await engine.waitFor((e) => e.type === "overdrive_changed");
    }
    const turn = await engine.runTurn("tidy the workspace");
    if (turn.errors.length > 0) throw new Error(turn.errors.join(" | "));
    return {
      line: status.text,
      asked: turn.events.some((e) => e.type === "permission_request"),
      deleted: !existsSync(doomed),
    };
  }

  override async run(t: TestRun): Promise<void> {
    for (const guard of [true, false]) {
      for (const overdrive of [false, true]) {
        const stance = `guard ${guard ? "on" : "off"}, OVERDRIVE ${overdrive ? "on" : "off"}`;
        const { line, asked, deleted } = await this.#stance(guard, overdrive);
        t.assert.equal(asked, !deleted, `${stance}: a deletion either asked (and was declined) or ran`);
        t.assert.doesNotMatch(line, /always ask/, `${stance}: "${line}" promises a prompt no stance always makes`);
        if (asked) {
          t.assert.match(line, /\bask\b/, `${stance}: the deletion asked, so the line must say it asks: "${line}"`);
        } else {
          t.assert.match(
            line,
            overdrive ? /OVERDRIVE|without asking/ : /without asking/,
            `${stance}: the deletion ran unasked, so the line must say so or name why: "${line}"`,
          );
        }
      }
    }

    // `/overdrive on` names the one refusal that is left besides deny rules.
    const workspace = this.#makeDir("magentra-status-od-");
    const engine = await startScriptedEngine({ workspace, turns: [{ text: "ok" }] });
    this.#engines.push(engine);
    engine.send({ type: "slash_command", command: "overdrive", args: "on" });
    const on = await engine.waitFor(
      (e): e is Extract<CoreEvent, { type: "command_output" }> => e.type === "command_output" && e.text.includes("OVERDRIVE engaged"),
    );
    t.assert.match(on.text, /nothing asks/);
    t.assert.match(on.text, /kill by process name is refused/, "the line names the kill-by-name refusal");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

const LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1";

class TheDesktopLinesMatchTheGuard extends UiTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "the-footer-hint-and-the-glossary-say-what-overdrive-does-to-the-guards";
  readonly whyItExists =
    "the footer read 'autonomous · deletions always ask' in OVERDRIVE and the glossary said the guard fires 'even in OVERDRIVE', so the desktop told the user the opposite of what the engine did";

  override async run(t: TestRun): Promise<void> {
    const home = this.makeTempDir("magentra-status-ui-home-");
    const workspace = this.makeTempDir("magentra-status-ui-ws-");
    this.writeJsonFile(join(workspace, ".magentra", "settings.json"), { provider: "openai-compatible", baseUrl: LOCAL_ENDPOINT, model: "model-one" });
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await openWorkspace(app, workspace);
    await waitForSpawn(workspace);

    const hint = (): Promise<string> => app.evaluate(`document.getElementById("hintAuto").textContent`);

    await app.evaluate(`(() => { disengageOverdrive(); return true; })()`);
    const normal = await hint();
    t.assert.doesNotMatch(normal, /asks? before commands/i, `outside OVERDRIVE commands run unasked: "${normal}"`);
    t.assert.match(normal, /deletions ask/, `and deletions ask: "${normal}"`);

    await app.evaluate(`(() => { engageOverdrive(false); return true; })()`);
    const od = await hint();
    t.assert.match(od, /nothing asks/, `in OVERDRIVE nothing asks: "${od}"`);
    t.assert.doesNotMatch(od, /deletions (always )?ask/, `and the deletion guard is off there: "${od}"`);
    await app.evaluate(`(() => { disengageOverdrive(); return true; })()`);

    const glossary = await app.evaluate<{ term: string; text: string }[]>(`
      [...document.querySelectorAll("#glossaryCard dt")].map((dt) => ({ term: dt.textContent.trim(), text: dt.nextElementSibling.textContent }))
    `);
    const deletion = glossary.find((g) => g.term === "deletion guard");
    t.assert.ok(deletion, "the glossary explains the deletion guard");
    t.assert.doesNotMatch(deletion!.text, /even in OVERDRIVE/);
    t.assert.match(deletion!.text, /OVERDRIVE turns it off/);
    const kill = glossary.find((g) => g.term === "process-kill guard");
    t.assert.ok(kill, "the glossary explains the process-kill guard");
    t.assert.match(kill!.text, /refused/);
  }
}

registerFeatureTests(new TheEngineLinesMatchTheGuard(), new TheDesktopLinesMatchTheGuard());
